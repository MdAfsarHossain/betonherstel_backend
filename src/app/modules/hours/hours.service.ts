import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { addDays, amsterdamToday, isValidDay } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { assertDailyLimit } from "./hours.limits";
import { pickRate } from "./hours.rates.service";
// Lazy: the work order module imports hours code too
const refreshWorkOrderPdfs = async (ids: string[]) =>
  (await import("../workorder/workorder.service")).WorkOrderService.refreshPdfForHours(ids);
import {
  IActor,
  IApprove,
  ICreateEntry,
  IStartTimer,
  IStopTimer,
  IUpdateEntry,
  entryStatuses,
  entryTypes,
} from "./hours.interface";

// Uren (SRS 4.11). Employees register hours on a project or work order (or internal
// time), by hand or with a start/stop timer. Office staff review them week by week,
// correct, approve or reject. Approving copies the employee's rates onto the entry, so
// approved hours become the project's cost and can later go on an invoice. Hours written
// on a work order are the same rows (table time_entries).

const staffRoles = ["SUPERADMIN", "ADMIN", "OFFICE"];
const isStaff = (actor: IActor) => staffRoles.includes(actor.role);
const employeeRoles = ["SUPERADMIN", "ADMIN", "OFFICE", "FIELD"];

// The crew can book hours at most this far back; the office can always correct later
const CREW_BACKDATE_DAYS = 60;
const MAX_RANGE_DAYS = 93;
const MAX_EXPORT_DAYS = 366;

const clean = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : (value ?? null);

const asList = (value: any): string[] =>
  String(Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Calendar helpers (weeks run Monday to Sunday, in Amsterdam time)
// ---------------------------------------------------------------------------

const dayOfWeek = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
const weekStartOf = (day: string) => addDays(day, -dayOfWeek(day));
const isoWeek = (monday: string) => {
  const thursday = new Date(`${addDays(monday, 3)}T12:00:00Z`);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return {
    year: thursday.getUTCFullYear(),
    week: Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7),
  };
};
const daysBetween = (from: string, to: string) =>
  Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);

const assertDay = (value: any, label: string) => {
  const day = String(value);
  if (!isValidDay(day)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${label} must be a date like 2026-11-30!`);
  }
  return day;
};

// ---------------------------------------------------------------------------
// Reading entries
// ---------------------------------------------------------------------------

const entryFrom = `
  FROM time_entries t
  JOIN users u ON u.id = t.user_id
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN work_orders w ON w.id = t.work_order_id
  LEFT JOIN users au ON au.id = t.approved_by
`;

// Employees never see rates or amounts; the office does
const entryColumns = (staff: boolean) => `
  t.id, to_char(t.work_date, 'YYYY-MM-DD') AS work_date, t.minutes,
  ROUND(t.minutes / 60.0, 2)::float8 AS hours,
  t.entry_type, t.is_billable, t.note, t.status, t.reject_reason,
  t.started_at, t.ended_at, t.approved_at, au.name AS approved_by_name,
  t.created_at AS "createdAt",
  json_build_object('id', u.id, 'name', u.name, 'role', u.role) AS employee,
  CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'number', p.number, 'title', p.title) END AS project,
  CASE WHEN w.id IS NULL THEN NULL ELSE json_build_object('id', w.id, 'number', w.number, 'title', w.title, 'status', w.status) END AS work_order
  ${
    staff
      ? `,
  (t.cost_rate_cents / 100.0)::float8 AS cost_rate,
  (t.sales_rate_cents / 100.0)::float8 AS sales_rate,
  (t.cost_cents / 100.0)::float8 AS cost,
  (t.sales_cents / 100.0)::float8 AS sales_value,
  (t.invoice_id IS NOT NULL) AS invoiced`
      : ""
  }
`;

const getEntryView = async (id: string, actor: IActor) => {
  const result = await query(`SELECT ${entryColumns(isStaff(actor))} ${entryFrom} WHERE t.id = $1::uuid`, [id]);
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Hour entry not found!");
  }
  return result.rows[0];
};

// The office's list with filters and totals
const getAllEntries = async (params: Record<string, any>, actorId: string) => {
  const { page, limit, skip, sortBy, sortOrder } = paginationHelper.calculatePagination(params as any);

  const sortable: Record<string, string> = {
    work_date: "t.work_date",
    created_at: "t.created_at",
    minutes: "t.minutes",
    status: "t.status",
    employee: "LOWER(u.name)",
  };
  const orderColumn = sortable[sortBy] ?? "t.work_date";
  const orderDirection = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  const conditions: string[] = [];
  const values: any[] = [];
  let n = 1;

  if (params.searchTerm) {
    const term = String(Array.isArray(params.searchTerm) ? params.searchTerm[0] : params.searchTerm)
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(
      `(u.name ILIKE $${n} OR p.number ILIKE $${n} OR p.title ILIKE $${n} OR w.number ILIKE $${n} OR t.note ILIKE $${n})`,
    );
    values.push(`%${term}%`);
    n++;
  }

  if (params.user_id) {
    const id = String(params.user_id) === "me" ? actorId : String(params.user_id);
    assertUuid(id, "user id");
    conditions.push(`t.user_id = $${n++}::uuid`);
    values.push(id);
  }
  for (const [param, column, label] of [
    ["project_id", "t.project_id", "project id"],
    ["work_order_id", "t.work_order_id", "work order id"],
  ] as const) {
    if (params[param]) {
      assertUuid(String(params[param]), label);
      conditions.push(`${column} = $${n++}::uuid`);
      values.push(String(params[param]));
    }
  }

  if (params.status) {
    const statuses = asList(params.status).map((s) => s.toUpperCase());
    if (statuses.some((s) => !(entryStatuses as readonly string[]).includes(s))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Status should be SUBMITTED, APPROVED or REJECTED!");
    }
    conditions.push(`t.status = ANY($${n++}::text[])`);
    values.push(statuses);
  }
  if (params.type) {
    const types = asList(params.type).map((s) => s.toUpperCase());
    if (types.some((s) => !(entryTypes as readonly string[]).includes(s))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Type should be WORK, TRAVEL, INSPECTION or INTERNAL!");
    }
    conditions.push(`t.entry_type = ANY($${n++}::text[])`);
    values.push(types);
  }
  if (params.billable !== undefined && params.billable !== "") {
    if (!["true", "false"].includes(String(params.billable))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "billable must be true or false!");
    }
    conditions.push(`t.is_billable = $${n++}::boolean`);
    values.push(String(params.billable) === "true");
  }
  for (const [param, operator] of [["from", ">="], ["to", "<="]] as const) {
    if (params[param]) {
      conditions.push(`t.work_date ${operator} $${n++}::date`);
      values.push(assertDay(params[param], param));
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [result, totals] = await Promise.all([
    query(
      `
        SELECT ${entryColumns(true)}
        ${entryFrom}
        ${where}
        ORDER BY ${orderColumn} ${orderDirection}, t.created_at DESC, t.id ASC
        LIMIT $${n} OFFSET $${n + 1}
      `,
      [...values, limit, skip],
    ),
    query(
      `
        SELECT COUNT(*)::int AS total,
               COALESCE(SUM(t.minutes), 0)::int AS minutes,
               COALESCE(SUM(t.minutes) FILTER (WHERE t.is_billable), 0)::int AS billable_minutes,
               COALESCE(SUM(t.minutes) FILTER (WHERE t.status = 'APPROVED'), 0)::int AS approved_minutes,
               COALESCE(SUM(t.minutes) FILTER (WHERE t.status = 'SUBMITTED'), 0)::int AS submitted_minutes
        ${entryFrom} ${where}
      `,
      values,
    ),
  ]);

  const t = totals.rows[0];
  const total = t.total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    totals: {
      entries: total,
      minutes: t.minutes,
      hours: round2(t.minutes / 60),
      billable_hours: round2(t.billable_minutes / 60),
      approved_hours: round2(t.approved_minutes / 60),
      submitted_hours: round2(t.submitted_minutes / 60),
    },
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

// An employee's own hours in a period (the current week by default)
const getMyEntries = async (userId: string, params: Record<string, any>) => {
  const today = amsterdamToday();
  const from = params.from ? assertDay(params.from, "from") : weekStartOf(today);
  const to = params.to ? assertDay(params.to, "to") : addDays(weekStartOf(from), 6);
  if (to < from) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The end of the period cannot be before its start!");
  }
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
    throw new ApiError(httpStatus.BAD_REQUEST, `A period can be at most ${MAX_RANGE_DAYS} days!`);
  }

  const result = await query(
    `
      SELECT ${entryColumns(false)}
      ${entryFrom}
      WHERE t.user_id = $1::uuid AND t.work_date BETWEEN $2::date AND $3::date
      ORDER BY t.work_date ASC, t.created_at ASC
    `,
    [userId, from, to],
  );

  const days = new Map<string, number>();
  let total = 0;
  let billable = 0;
  const byStatus: Record<string, number> = { SUBMITTED: 0, APPROVED: 0, REJECTED: 0 };
  for (const e of result.rows) {
    days.set(e.work_date, (days.get(e.work_date) ?? 0) + e.minutes);
    total += e.minutes;
    if (e.is_billable) billable += e.minutes;
    byStatus[e.status] += e.minutes;
  }

  return {
    entries: result.rows,
    summary: {
      from,
      to,
      total_minutes: total,
      total_hours: round2(total / 60),
      billable_hours: round2(billable / 60),
      by_status: {
        submitted_hours: round2(byStatus.SUBMITTED / 60),
        approved_hours: round2(byStatus.APPROVED / 60),
        rejected_hours: round2(byStatus.REJECTED / 60),
      },
      days: [...days.entries()].map(([date, minutes]) => ({ date, minutes, hours: round2(minutes / 60) })),
    },
  };
};

// ---------------------------------------------------------------------------
// Creating (FR-HRS-01, FR-HRS-02)
// ---------------------------------------------------------------------------

const assertEmployee = async (userId: string, client?: any) => {
  assertUuid(userId, "user id");
  const run = client ? client.query.bind(client) : query;
  const found = await run(
    `SELECT id FROM users WHERE id = $1::uuid AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`,
    [userId, employeeRoles],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Hours can only be registered for an active employee!");
  }
};

// Checks what an entry is booked on and whether this person may book there
const resolveTarget = async (
  client: any,
  actor: IActor,
  userId: string,
  target: { project_id?: string | null; work_order_id?: string | null; entry_type: string },
) => {
  if (target.entry_type === "INTERNAL") {
    return { projectId: null as string | null, workOrderId: null as string | null };
  }

  let projectId = target.project_id ?? null;
  let workOrderId = target.work_order_id ?? null;

  if (workOrderId) {
    assertUuid(workOrderId, "work order id");
    const wo = await client.query(`SELECT id, project_id, status FROM work_orders WHERE id = $1::uuid`, [workOrderId]);
    if (wo.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Work order not found!");
    }
    if (projectId && projectId !== wo.rows[0].project_id) {
      throw new ApiError(httpStatus.BAD_REQUEST, "This work order belongs to another project!");
    }
    projectId = wo.rows[0].project_id;
    if (!isStaff(actor)) {
      const assigned = await client.query(
        `SELECT 1 FROM work_order_assignees WHERE work_order_id = $1::uuid AND user_id = $2::uuid`,
        [workOrderId, actor.id],
      );
      if (assigned.rows.length === 0) {
        throw new ApiError(httpStatus.NOT_FOUND, "Work order not found!");
      }
    }
    if (wo.rows[0].status === "CHECKED" || (!isStaff(actor) && wo.rows[0].status === "COMPLETED")) {
      throw new ApiError(httpStatus.CONFLICT, "This work order is completed. Ask the office to register hours!");
    }
  }

  assertUuid(projectId as string, "project id");
  const project = await client.query(`SELECT id, closed_at FROM projects WHERE id = $1::uuid`, [projectId]);
  if (project.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }
  if (!isStaff(actor)) {
    // The crew book on the projects they are planned on
    const planned = await client.query(
      `
        SELECT 1 WHERE
          EXISTS (SELECT 1 FROM appointments a JOIN appointment_assignees aa ON aa.appointment_id = a.id
                  WHERE a.project_id = $1::uuid AND aa.user_id = $2::uuid AND a.status <> 'CANCELLED')
          OR EXISTS (SELECT 1 FROM work_orders w JOIN work_order_assignees wa ON wa.work_order_id = w.id
                     WHERE w.project_id = $1::uuid AND wa.user_id = $2::uuid)
      `,
      [projectId, userId],
    );
    if (planned.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
    }
    if (project.rows[0].closed_at) {
      throw new ApiError(httpStatus.CONFLICT, "This project is closed. Ask the office to register hours!");
    }
  }

  return { projectId, workOrderId };
};

const assertWorkDate = (actor: IActor, workDate: string) => {
  const today = amsterdamToday();
  if (workDate > today) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Hours cannot be registered for a future date!");
  }
  if (!isStaff(actor) && workDate < addDays(today, -CREW_BACKDATE_DAYS)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Hours can be registered at most ${CREW_BACKDATE_DAYS} days back. Ask the office!`,
    );
  }
};

// The minutes of a start and an end time
const minutesBetween = (startedAt: Date, endedAt: Date) => {
  if (!(endedAt.getTime() > startedAt.getTime())) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The end must be after the start!");
  }
  if (endedAt.getTime() > Date.now() + 60_000) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The end cannot be in the future!");
  }
  const minutes = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000));
  if (minutes > 1440) {
    throw new ApiError(httpStatus.BAD_REQUEST, "An entry can be at most 24 hours. Split it over days!");
  }
  return minutes;
};

interface INewEntry {
  userId: string;
  projectId: string | null;
  workOrderId: string | null;
  workDate: string;
  minutes: number;
  entryType: string;
  isBillable: boolean;
  note: string | null;
  clientId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdBy: string;
}

const insertEntry = async (client: any, e: INewEntry) => {
  await assertDailyLimit(client, e.userId, e.workDate, e.minutes);
  const result = await client.query(
    `
      INSERT INTO time_entries (
        project_id, work_order_id, user_id, work_date, minutes, entry_type, is_billable, note,
        client_id, started_at, ended_at, created_by
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8, $9::uuid, $10::timestamptz, $11::timestamptz, $12::uuid)
      RETURNING id
    `,
    [
      e.projectId,
      e.workOrderId,
      e.userId,
      e.workDate,
      e.minutes,
      e.entryType,
      e.isBillable,
      e.note,
      e.clientId,
      e.startedAt?.toISOString() ?? null,
      e.endedAt?.toISOString() ?? null,
      e.createdBy,
    ],
  );
  return result.rows[0].id as string;
};

// Registers hours by hand: minutes, or a start and an end time. Sending the same
// client_id again (a phone that was offline) returns the entry that is already there.
const createEntry = async (input: ICreateEntry, actor: IActor) => {
  const userId = input.user_id ?? actor.id;
  if (userId !== actor.id) {
    if (!isStaff(actor)) {
      throw new ApiError(httpStatus.FORBIDDEN, "You can only register your own hours!");
    }
  }

  const entryType = input.entry_type ?? "WORK";
  let workDate: string;
  let minutes: number;
  let startedAt: Date | null = null;
  let endedAt: Date | null = null;
  if (input.started_at && input.ended_at) {
    startedAt = new Date(input.started_at);
    endedAt = new Date(input.ended_at);
    minutes = minutesBetween(startedAt, endedAt);
    workDate = amsterdamToday(startedAt);
    if (input.work_date && input.work_date !== workDate) {
      throw new ApiError(httpStatus.BAD_REQUEST, "The date does not match the start time!");
    }
  } else {
    minutes = input.minutes as number;
    workDate = input.work_date ?? amsterdamToday();
  }
  assertWorkDate(actor, workDate);

  const id = await transaction(async (client) => {
    if (userId !== actor.id) await assertEmployee(userId, client);

    if (input.client_id) {
      const seen = await client.query(`SELECT id FROM time_entries WHERE user_id = $1::uuid AND client_id = $2::uuid`, [
        userId,
        input.client_id,
      ]);
      if (seen.rows.length > 0) return seen.rows[0].id as string;
    }

    const target = await resolveTarget(client, actor, userId, {
      project_id: input.project_id,
      work_order_id: input.work_order_id,
      entry_type: entryType,
    });

    return insertEntry(client, {
      userId,
      projectId: target.projectId,
      workOrderId: target.workOrderId,
      workDate,
      minutes,
      entryType,
      // Internal time is never billed to a customer
      isBillable: entryType === "INTERNAL" ? false : input.is_billable !== false,
      note: clean(input.note),
      clientId: input.client_id ?? null,
      startedAt,
      endedAt,
      createdBy: actor.id,
    });
  });

  return getEntryView(id, actor);
};

// ---------------------------------------------------------------------------
// Editing and deleting
// ---------------------------------------------------------------------------

// Locks the entry and checks who may change it. The office can correct anything that is
// not approved; approving locks an entry until it is unapproved.
const lockEditable = async (client: any, id: string, actor: IActor) => {
  assertUuid(id, "hour entry id");
  const found = await client.query(
    `
      SELECT id, user_id, work_order_id, entry_type, status, invoice_id,
             to_char(work_date, 'YYYY-MM-DD') AS work_date, minutes, is_billable
      FROM time_entries WHERE id = $1::uuid FOR UPDATE
    `,
    [id],
  );
  const entry = found.rows[0];
  // Someone else's entry looks like a missing one
  if (!entry || (!isStaff(actor) && entry.user_id !== actor.id)) {
    throw new ApiError(httpStatus.NOT_FOUND, "Hour entry not found!");
  }

  if (entry.invoice_id) {
    throw new ApiError(httpStatus.CONFLICT, "This hour entry is on an invoice and can no longer be changed!");
  }
  if (entry.status === "APPROVED") {
    throw new ApiError(httpStatus.CONFLICT, "This hour entry has been approved. Unapprove it first!");
  }

  // A work order that is completed or checked keeps its hours, like on the work order itself
  if (entry.work_order_id) {
    const wo = await client.query(`SELECT status FROM work_orders WHERE id = $1::uuid`, [entry.work_order_id]);
    const status = wo.rows[0]?.status;
    if (status === "CHECKED" || (!isStaff(actor) && status === "COMPLETED")) {
      throw new ApiError(httpStatus.CONFLICT, "The work order is completed. Ask the office to correct the hours!");
    }
  }
  return entry;
};

const updateEntry = async (id: string, payload: IUpdateEntry, actor: IActor) => {
  await transaction(async (client) => {
    const entry = await lockEditable(client, id, actor);

    const entryType = payload.entry_type ?? entry.entry_type;
    if ((entryType === "INTERNAL") !== (entry.entry_type === "INTERNAL")) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Internal time and project hours cannot be switched. Delete it and add a new entry!");
    }
    if (entryType === "INTERNAL" && payload.is_billable === true) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Internal time cannot be billable!");
    }

    const workDate = payload.work_date ?? entry.work_date;
    const minutes = payload.minutes ?? entry.minutes;
    if (payload.work_date !== undefined) assertWorkDate(actor, workDate);
    await assertDailyLimit(client, entry.user_id, workDate, minutes, id);

    const data: Record<string, any> = {};
    if (payload.work_date !== undefined) data.work_date = payload.work_date;
    if (payload.minutes !== undefined) data.minutes = payload.minutes;
    if (payload.entry_type !== undefined) data.entry_type = payload.entry_type;
    if (payload.is_billable !== undefined) data.is_billable = payload.is_billable;
    if (payload.note !== undefined) data.note = clean(payload.note);

    const updates: string[] = [];
    const values: any[] = [];
    let n = 1;
    for (const [field, value] of Object.entries(data)) {
      updates.push(`${field} = $${n++}${field === "work_date" ? "::date" : ""}`);
      values.push(value);
    }
    // A corrected duration no longer matches the recorded start and end
    if (payload.minutes !== undefined || payload.work_date !== undefined) {
      updates.push(`started_at = NULL`, `ended_at = NULL`);
    }
    // A corrected, rejected entry goes back for review
    updates.push(`status = 'SUBMITTED'`, `reject_reason = NULL`, `updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    await client.query(`UPDATE time_entries SET ${updates.join(", ")} WHERE id = $${n}::uuid`, values);

    if (isStaff(actor)) {
      await logAudit(
        { actor_id: actor.id, action: "UPDATE", entity_type: "time_entry", entity_id: id, changes: { fields: Object.keys(data) } },
        client,
      );
    }
  });

  return getEntryView(id, actor);
};

const deleteEntry = async (id: string, actor: IActor) => {
  await transaction(async (client) => {
    const entry = await lockEditable(client, id, actor);
    await client.query(`DELETE FROM time_entries WHERE id = $1::uuid`, [id]);
    if (isStaff(actor)) {
      await logAudit(
        {
          actor_id: actor.id,
          action: "DELETE",
          entity_type: "time_entry",
          entity_id: id,
          changes: { user_id: entry.user_id, work_date: entry.work_date, minutes: entry.minutes },
        },
        client,
      );
    }
  });
};

// ---------------------------------------------------------------------------
// The start/stop timer (FR-HRS-01)
// ---------------------------------------------------------------------------

const timerView = async (userId: string) => {
  const result = await query(
    `
      SELECT tt.entry_type, tt.is_billable, tt.note, tt.started_at,
             GREATEST(0, ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - tt.started_at)) / 60))::int AS elapsed_minutes,
             CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'number', p.number, 'title', p.title) END AS project,
             CASE WHEN w.id IS NULL THEN NULL ELSE json_build_object('id', w.id, 'number', w.number, 'title', w.title) END AS work_order
      FROM time_timers tt
      LEFT JOIN projects p ON p.id = tt.project_id
      LEFT JOIN work_orders w ON w.id = tt.work_order_id
      WHERE tt.user_id = $1::uuid
    `,
    [userId],
  );
  if (result.rows.length === 0) return { running: false };
  return { running: true, ...result.rows[0] };
};

const getTimer = (actor: IActor) => timerView(actor.id);

const startTimer = async (input: IStartTimer, actor: IActor) => {
  const entryType = input.entry_type ?? "WORK";

  await transaction(async (client) => {
    const running = await client.query(`SELECT 1 FROM time_timers WHERE user_id = $1::uuid FOR UPDATE`, [actor.id]);
    if (running.rows.length > 0) {
      throw new ApiError(httpStatus.CONFLICT, "A timer is already running. Stop it first!");
    }
    const target = await resolveTarget(client, actor, actor.id, {
      project_id: input.project_id,
      work_order_id: input.work_order_id,
      entry_type: entryType,
    });
    await client.query(
      `
        INSERT INTO time_timers (user_id, project_id, work_order_id, entry_type, is_billable, note)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)
      `,
      [
        actor.id,
        target.projectId,
        target.workOrderId,
        entryType,
        entryType === "INTERNAL" ? false : input.is_billable !== false,
        clean(input.note),
      ],
    );
  }).catch((error: any) => {
    // Two starts at the same moment: the second finds the first
    if (error?.code === "23505") {
      throw new ApiError(httpStatus.CONFLICT, "A timer is already running. Stop it first!");
    }
    throw error;
  });

  return timerView(actor.id);
};

// Stopping turns the timer into an hour entry. A timer someone forgot to stop is closed
// with the real end time instead (ended_at).
const stopTimer = async (input: IStopTimer, actor: IActor) => {
  const id = await transaction(async (client) => {
    const found = await client.query(`SELECT * FROM time_timers WHERE user_id = $1::uuid FOR UPDATE`, [actor.id]);
    if (found.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "No timer is running!");
    }
    const timer = found.rows[0];

    const startedAt = new Date(timer.started_at);
    const endedAt = input.ended_at ? new Date(input.ended_at) : new Date();
    if (!input.ended_at && endedAt.getTime() - startedAt.getTime() > 1440 * 60_000) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "This timer has been running for more than 24 hours. Stop it with the time you really stopped (ended_at)!",
      );
    }
    const minutes = minutesBetween(startedAt, endedAt);
    const workDate = amsterdamToday(startedAt);
    assertWorkDate(actor, workDate);

    const target = await resolveTarget(client, actor, actor.id, {
      project_id: timer.project_id,
      work_order_id: timer.work_order_id,
      entry_type: timer.entry_type,
    });

    const entryId = await insertEntry(client, {
      userId: actor.id,
      projectId: target.projectId,
      workOrderId: target.workOrderId,
      workDate,
      minutes,
      entryType: timer.entry_type,
      isBillable: timer.is_billable,
      note: input.note !== undefined ? clean(input.note) : timer.note,
      clientId: null,
      startedAt,
      endedAt,
      createdBy: actor.id,
    });
    await client.query(`DELETE FROM time_timers WHERE user_id = $1::uuid`, [actor.id]);
    return entryId;
  });

  return getEntryView(id, actor);
};

// Throws the timer away without making an entry
const discardTimer = async (actor: IActor) => {
  const removed = await query(`DELETE FROM time_timers WHERE user_id = $1::uuid RETURNING user_id`, [actor.id]);
  if (removed.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "No timer is running!");
  }
};

// ---------------------------------------------------------------------------
// What can I book on? (for the project picker)
// ---------------------------------------------------------------------------

const getBookableProjects = async (actor: IActor, params: Record<string, any>) => {
  const conditions = [`p.closed_at IS NULL`];
  const values: any[] = [];
  let n = 1;

  if (!isStaff(actor)) {
    conditions.push(`(
      EXISTS (SELECT 1 FROM appointments a JOIN appointment_assignees aa ON aa.appointment_id = a.id
              WHERE a.project_id = p.id AND aa.user_id = $${n}::uuid AND a.status <> 'CANCELLED')
      OR EXISTS (SELECT 1 FROM work_orders w JOIN work_order_assignees wa ON wa.work_order_id = w.id
                 WHERE w.project_id = p.id AND wa.user_id = $${n}::uuid)
    )`);
    values.push(actor.id);
    n++;
  }
  if (params.searchTerm) {
    const term = String(Array.isArray(params.searchTerm) ? params.searchTerm[0] : params.searchTerm)
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(`(p.number ILIKE $${n} OR p.title ILIKE $${n} OR r.name ILIKE $${n} OR p.city ILIKE $${n})`);
    values.push(`%${term}%`);
    n++;
  }
  const userParam = isStaff(actor) ? null : actor.id;

  const result = await query(
    `
      SELECT p.id, p.number, p.title, p.city, r.name AS customer_name,
             COALESCE((
               SELECT json_agg(json_build_object('id', w.id, 'number', w.number, 'title', w.title, 'status', w.status)
                               ORDER BY w.created_at)
               FROM work_orders w
               WHERE w.project_id = p.id AND w.status IN ('OPEN', 'IN_PROGRESS')
                 AND ($${n}::uuid IS NULL OR EXISTS (SELECT 1 FROM work_order_assignees wa WHERE wa.work_order_id = w.id AND wa.user_id = $${n}::uuid))
             ), '[]'::json) AS work_orders
      FROM projects p JOIN relations r ON r.id = p.relation_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY p.created_at DESC
      LIMIT 100
    `,
    [...values, userParam],
  );
  return result.rows;
};

// ---------------------------------------------------------------------------
// Weekly overview, approval (FR-HRS-03)
// ---------------------------------------------------------------------------

// One row per employee, one column per day, with what is still waiting for review
const getWeek = async (params: Record<string, any>, actorId: string) => {
  const today = amsterdamToday();
  const weekStart = params.week_start ? assertDay(params.week_start, "week_start") : weekStartOf(today);
  if (dayOfWeek(weekStart) !== 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "week_start must be a Monday!");
  }
  const weekEnd = addDays(weekStart, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const values: any[] = [weekStart, weekEnd];
  let userFilter = "";
  if (params.user_id) {
    const id = String(params.user_id) === "me" ? actorId : String(params.user_id);
    assertUuid(id, "user id");
    values.push(id);
    userFilter = `AND t.user_id = $3::uuid`;
  }

  const result = await query(
    `
      SELECT t.user_id, u.name, u.role::text AS role, to_char(t.work_date, 'YYYY-MM-DD') AS day,
             SUM(t.minutes)::int AS minutes,
             COALESCE(SUM(t.minutes) FILTER (WHERE t.is_billable), 0)::int AS billable,
             COALESCE(SUM(t.minutes) FILTER (WHERE t.status = 'SUBMITTED'), 0)::int AS submitted,
             COALESCE(SUM(t.minutes) FILTER (WHERE t.status = 'APPROVED'), 0)::int AS approved,
             COALESCE(SUM(t.minutes) FILTER (WHERE t.status = 'REJECTED'), 0)::int AS rejected,
             COUNT(*)::int AS entries,
             COUNT(*) FILTER (WHERE t.status = 'SUBMITTED')::int AS submitted_entries
      FROM time_entries t JOIN users u ON u.id = t.user_id
      WHERE t.work_date BETWEEN $1::date AND $2::date ${userFilter}
      GROUP BY t.user_id, u.name, u.role, t.work_date
    `,
    values,
  );

  const employees = new Map<string, any>();
  const blank = (id: string, name: string, role: string) => ({
    user: { id, name, role },
    days: Object.fromEntries(days.map((d) => [d, 0])) as Record<string, number>,
    total_minutes: 0,
    billable_minutes: 0,
    submitted_minutes: 0,
    approved_minutes: 0,
    rejected_minutes: 0,
    entry_count: 0,
    submitted_entries: 0,
  });

  for (const r of result.rows) {
    const e = employees.get(r.user_id) ?? blank(r.user_id, r.name, r.role);
    e.days[r.day] = r.minutes;
    e.total_minutes += r.minutes;
    e.billable_minutes += r.billable;
    e.submitted_minutes += r.submitted;
    e.approved_minutes += r.approved;
    e.rejected_minutes += r.rejected;
    e.entry_count += r.entries;
    e.submitted_entries += r.submitted_entries;
    employees.set(r.user_id, e);
  }

  // Colleagues who booked nothing, if asked for
  if (String(params.include_empty) === "true" && !params.user_id) {
    const everyone = await query(
      `SELECT id, name, role::text AS role FROM users WHERE is_active AND status = 'ACTIVE' AND role::text = ANY($1::text[])`,
      [employeeRoles],
    );
    for (const u of everyone.rows) {
      if (!employees.has(u.id)) employees.set(u.id, blank(u.id, u.name, u.role));
    }
  }

  const list = [...employees.values()]
    .map((e) => ({
      user: e.user,
      days: days.map((d) => ({ date: d, minutes: e.days[d], hours: round2(e.days[d] / 60) })),
      total_hours: round2(e.total_minutes / 60),
      billable_hours: round2(e.billable_minutes / 60),
      submitted_hours: round2(e.submitted_minutes / 60),
      approved_hours: round2(e.approved_minutes / 60),
      rejected_hours: round2(e.rejected_minutes / 60),
      entry_count: e.entry_count,
      // Waiting for the office to approve
      needs_review: e.submitted_entries > 0,
      // Everything of this week is approved
      all_approved: e.entry_count > 0 && e.submitted_minutes === 0 && e.rejected_minutes === 0,
      _total: e.total_minutes,
      _name: String(e.user.name).toLowerCase(),
    }))
    .sort((a, b) => a._name.localeCompare(b._name))
    .map(({ _total, _name, ...rest }) => rest);

  const sum = (key: "total_hours" | "billable_hours" | "submitted_hours" | "approved_hours" | "rejected_hours") =>
    round2(list.reduce((n, e) => n + e[key], 0));
  const { year, week } = isoWeek(weekStart);

  return {
    week_start: weekStart,
    week_end: weekEnd,
    iso_week: week,
    iso_year: year,
    days,
    employees: list,
    totals: {
      total_hours: sum("total_hours"),
      billable_hours: sum("billable_hours"),
      submitted_hours: sum("submitted_hours"),
      approved_hours: sum("approved_hours"),
      rejected_hours: sum("rejected_hours"),
    },
  };
};

const rateCostCents = (minutes: number, rateCents: number) => Math.round((minutes * rateCents) / 60);

// Approves entries, either the ones named or everything an employee has waiting in a week.
// Each approved entry gets the employee's rates of its work date copied onto it, so later
// rate changes never rewrite history. Office staff cannot approve their own hours.
const approve = async (input: IApprove, actor: IActor) => {
  if (input.week_start && dayOfWeek(assertDay(input.week_start, "week_start")) !== 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "week_start must be a Monday!");
  }

  const approvedIds: string[] = [];
  const summary = await transaction(async (client) => {
    let rows: any[];
    if (input.entry_ids) {
      const ids = [...new Set(input.entry_ids)];
      const found = await client.query(
        `
          SELECT id, user_id, status, minutes, is_billable, to_char(work_date, 'YYYY-MM-DD') AS work_date
          FROM time_entries WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE
        `,
        [ids],
      );
      if (found.rows.length !== ids.length) {
        throw new ApiError(httpStatus.NOT_FOUND, "An hour entry was not found!");
      }
      rows = found.rows;
    } else {
      assertUuid(input.user_id as string, "user id");
      const weekEnd = addDays(input.week_start as string, 6);
      const found = await client.query(
        `
          SELECT id, user_id, status, minutes, is_billable, to_char(work_date, 'YYYY-MM-DD') AS work_date
          FROM time_entries
          WHERE user_id = $1::uuid AND status = 'SUBMITTED' AND work_date BETWEEN $2::date AND $3::date
          ORDER BY id FOR UPDATE
        `,
        [input.user_id, input.week_start, weekEnd],
      );
      rows = found.rows;
    }

    const userIds = [...new Set(rows.map((r) => r.user_id as string))];
    const rateRows = userIds.length
      ? await client.query(
          `SELECT user_id, effective_from::text AS effective_from, cost_rate_cents, sales_rate_cents
           FROM employee_rates WHERE user_id = ANY($1::uuid[]) ORDER BY effective_from DESC`,
          [userIds],
        )
      : { rows: [] as any[] };
    const ratesByUser = new Map<string, any[]>();
    for (const r of rateRows.rows) ratesByUser.set(r.user_id, [...(ratesByUser.get(r.user_id) ?? []), r]);

    let approved = 0;
    let skippedStatus = 0;
    let skippedOwn = 0;
    const withoutRate = new Map<string, number>();
    const perUser = new Map<string, { entries: number; minutes: number; ids: string[] }>();

    for (const e of rows) {
      if (e.status !== "SUBMITTED") {
        skippedStatus++;
        continue;
      }
      // The people who approve do not approve themselves (the Beheerder can)
      if (e.user_id === actor.id && actor.role === "OFFICE") {
        skippedOwn++;
        continue;
      }

      const rate = pickRate(ratesByUser.get(e.user_id) ?? [], e.work_date);
      if (!rate) withoutRate.set(e.user_id, (withoutRate.get(e.user_id) ?? 0) + 1);
      const cost = rate ? rateCostCents(e.minutes, rate.cost_rate_cents) : 0;
      const sales = rate && e.is_billable ? rateCostCents(e.minutes, rate.sales_rate_cents) : 0;

      await client.query(
        `
          UPDATE time_entries
          SET status = 'APPROVED', approved_by = $2::uuid, approved_at = CURRENT_TIMESTAMP, reject_reason = NULL,
              cost_rate_cents = $3, sales_rate_cents = $4, cost_cents = $5, sales_cents = $6, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1::uuid
        `,
        [e.id, actor.id, rate?.cost_rate_cents ?? null, rate?.sales_rate_cents ?? null, cost, sales],
      );
      approved++;
      approvedIds.push(e.id);
      const p = perUser.get(e.user_id) ?? { entries: 0, minutes: 0, ids: [] };
      p.entries++;
      p.minutes += e.minutes;
      if (p.ids.length < 100) p.ids.push(e.id);
      perUser.set(e.user_id, p);
    }

    for (const [userId, p] of perUser) {
      await logAudit(
        {
          actor_id: actor.id,
          action: "STATUS_CHANGE",
          entity_type: "hours_approval",
          entity_id: userId,
          changes: { to: "APPROVED", entries: p.entries, minutes: p.minutes, entry_ids: p.ids },
        },
        client,
      );
    }

    const names = userIds.length
      ? await client.query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [[...withoutRate.keys()]])
      : { rows: [] as any[] };
    const nameOf = new Map<string, string>(names.rows.map((r: any) => [r.id, r.name]));

    return {
      approved,
      skipped_not_submitted: skippedStatus,
      skipped_own: skippedOwn,
      // Approved without a rate: cost and sales value are 0 until a rate is set and the entry is re-approved
      without_rate: [...withoutRate.entries()].map(([user_id, entries]) => ({ user_id, name: nameOf.get(user_id) ?? "", entries })),
    };
  });

  await refreshWorkOrderPdfs(approvedIds);
  return summary;
};

const lockEntryForReview = async (client: any, id: string) => {
  assertUuid(id, "hour entry id");
  const found = await client.query(
    `SELECT id, user_id, status, invoice_id, minutes, to_char(work_date, 'YYYY-MM-DD') AS work_date
     FROM time_entries WHERE id = $1::uuid FOR UPDATE`,
    [id],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Hour entry not found!");
  }
  return found.rows[0];
};

// Sends an entry back to the employee with a reason; they correct it and it returns to review
const rejectEntry = async (id: string, reason: string, actor: IActor) => {
  await transaction(async (client) => {
    const entry = await lockEntryForReview(client, id);
    if (entry.status !== "SUBMITTED") {
      throw new ApiError(
        httpStatus.CONFLICT,
        entry.status === "APPROVED" ? "This entry is approved. Unapprove it first!" : "This entry has already been rejected!",
      );
    }
    await client.query(
      `UPDATE time_entries SET status = 'REJECTED', reject_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, reason.trim()],
    );
    await logAudit(
      { actor_id: actor.id, action: "STATUS_CHANGE", entity_type: "time_entry", entity_id: id, changes: { to: "REJECTED", reason: reason.trim() } },
      client,
    );
  });
  return getEntryView(id, actor);
};

// Back to "waiting for review": the copied rates and amounts are dropped. Not once invoiced.
const unapproveEntry = async (id: string, reason: string | undefined, actor: IActor) => {
  await transaction(async (client) => {
    const entry = await lockEntryForReview(client, id);
    if (entry.invoice_id) {
      throw new ApiError(httpStatus.CONFLICT, "This hour entry is on an invoice and can no longer be changed!");
    }
    if (entry.status !== "APPROVED") {
      throw new ApiError(httpStatus.CONFLICT, "Only an approved entry can be unapproved!");
    }
    await client.query(
      `
        UPDATE time_entries
        SET status = 'SUBMITTED', approved_by = NULL, approved_at = NULL,
            cost_rate_cents = NULL, sales_rate_cents = NULL, cost_cents = NULL, sales_cents = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [id],
    );
    await logAudit(
      {
        actor_id: actor.id,
        action: "STATUS_CHANGE",
        entity_type: "time_entry",
        entity_id: id,
        changes: { to: "SUBMITTED", unapproved: true, reason: clean(reason) },
      },
      client,
    );
  });
  await refreshWorkOrderPdfs([id]);
  return getEntryView(id, actor);
};

// ---------------------------------------------------------------------------
// For invoices (FR-HRS-04): approved, billable hours not yet invoiced
// ---------------------------------------------------------------------------

const getBillableForProject = async (projectId: string, client?: any) => {
  assertUuid(projectId, "project id");
  const run = client ? client.query.bind(client) : query;

  const project = await run(`SELECT id, number, title FROM projects WHERE id = $1::uuid`, [projectId]);
  if (project.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }

  const result = await run(
    `
      SELECT t.id, to_char(t.work_date, 'YYYY-MM-DD') AS work_date, t.minutes,
             ROUND(t.minutes / 60.0, 2)::float8 AS hours, t.entry_type, t.note,
             json_build_object('id', u.id, 'name', u.name) AS employee,
             (t.sales_rate_cents / 100.0)::float8 AS sales_rate,
             (t.sales_cents / 100.0)::float8 AS sales_value,
             (t.sales_rate_cents IS NULL) AS rate_missing
      FROM time_entries t JOIN users u ON u.id = t.user_id
      WHERE t.project_id = $1::uuid AND t.status = 'APPROVED' AND t.is_billable AND t.invoice_id IS NULL
      ORDER BY t.work_date ASC, u.name ASC, t.created_at ASC
    `,
    [projectId],
  );

  const minutes = result.rows.reduce((n: number, e: any) => n + e.minutes, 0);
  const salesCents = result.rows.reduce((n: number, e: any) => n + Math.round((e.sales_value ?? 0) * 100), 0);
  return {
    project: project.rows[0],
    entries: result.rows,
    totals: {
      entries: result.rows.length,
      minutes,
      hours: round2(minutes / 60),
      sales_value: salesCents / 100,
      without_rate: result.rows.filter((e: any) => e.rate_missing).length,
    },
  };
};

// ---------------------------------------------------------------------------
// Export for payroll (FR-HRS-05)
// ---------------------------------------------------------------------------

// A cell that starts with = + - @ would be run as a formula by Excel: make it plain text
const csvCell = (value: any, delimiter: string) => {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  // Only what would break the row is quoted: a decimal comma in a semicolon file stays as it is
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
};

// CSV with a byte order mark and semicolons: Excel (Dutch settings) opens it directly.
// Rows per entry, or `group=employee` for one line per employee with totals.
const exportCsv = async (params: Record<string, any>) => {
  if (!params.from || !params.to) {
    throw new ApiError(httpStatus.BAD_REQUEST, "from and to are required (e.g. from=2026-11-01&to=2026-11-30)!");
  }
  const from = assertDay(params.from, "from");
  const to = assertDay(params.to, "to");
  if (to < from) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The end of the period cannot be before its start!");
  }
  if (daysBetween(from, to) + 1 > MAX_EXPORT_DAYS) {
    throw new ApiError(httpStatus.BAD_REQUEST, `A period can be at most ${MAX_EXPORT_DAYS} days!`);
  }

  const delimiter = String(params.delimiter ?? "semicolon") === "comma" ? "," : ";";
  const decimal = delimiter === ";" ? "," : ".";
  const hoursText = (minutes: number) => (Math.round((minutes / 60) * 100) / 100).toFixed(2).replace(".", decimal);

  const conditions = [`t.work_date BETWEEN $1::date AND $2::date`];
  const values: any[] = [from, to];
  let n = 3;

  // Payroll is paid on approved hours unless asked otherwise
  const statusParam = String(params.status ?? "APPROVED").toUpperCase();
  if (statusParam !== "ALL") {
    const statuses = asList(statusParam);
    if (statuses.some((s) => !(entryStatuses as readonly string[]).includes(s))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Status should be SUBMITTED, APPROVED, REJECTED or ALL!");
    }
    conditions.push(`t.status = ANY($${n++}::text[])`);
    values.push(statuses);
  }
  if (params.user_id) {
    assertUuid(String(params.user_id), "user id");
    conditions.push(`t.user_id = $${n++}::uuid`);
    values.push(String(params.user_id));
  }
  if (params.project_id) {
    assertUuid(String(params.project_id), "project id");
    conditions.push(`t.project_id = $${n++}::uuid`);
    values.push(String(params.project_id));
  }
  const where = conditions.join(" AND ");
  const row = (cells: any[]) => cells.map((c) => csvCell(c, delimiter)).join(delimiter);
  const lines: string[] = [];

  if (String(params.group) === "employee") {
    const result = await query(
      `
        SELECT u.name, SUM(t.minutes)::int AS minutes,
               COALESCE(SUM(t.minutes) FILTER (WHERE t.is_billable), 0)::int AS billable,
               COALESCE(SUM(t.minutes) FILTER (WHERE t.entry_type = 'WORK'), 0)::int AS work,
               COALESCE(SUM(t.minutes) FILTER (WHERE t.entry_type = 'TRAVEL'), 0)::int AS travel,
               COALESCE(SUM(t.minutes) FILTER (WHERE t.entry_type = 'INSPECTION'), 0)::int AS inspection,
               COALESCE(SUM(t.minutes) FILTER (WHERE t.entry_type = 'INTERNAL'), 0)::int AS internal,
               COUNT(*)::int AS entries
        FROM time_entries t JOIN users u ON u.id = t.user_id
        WHERE ${where}
        GROUP BY u.id, u.name ORDER BY LOWER(u.name) ASC
      `,
      values,
    );
    lines.push(row(["Employee", "Entries", "Hours", "Billable hours", "Non-billable hours", "Work", "Travel", "Inspection", "Internal"]));
    for (const r of result.rows) {
      lines.push(
        row([r.name, r.entries, hoursText(r.minutes), hoursText(r.billable), hoursText(r.minutes - r.billable), hoursText(r.work), hoursText(r.travel), hoursText(r.inspection), hoursText(r.internal)]),
      );
    }
  } else {
    const result = await query(
      `
        SELECT u.name AS employee, to_char(t.work_date, 'YYYY-MM-DD') AS work_date,
               p.number AS project_number, p.title AS project_title, w.number AS work_order_number,
               t.entry_type, t.is_billable, t.minutes, t.status, au.name AS approved_by,
               to_char(t.approved_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD') AS approved_on, t.note
        FROM time_entries t
        JOIN users u ON u.id = t.user_id
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN work_orders w ON w.id = t.work_order_id
        LEFT JOIN users au ON au.id = t.approved_by
        WHERE ${where}
        ORDER BY LOWER(u.name) ASC, t.work_date ASC, t.created_at ASC
      `,
      values,
    );
    lines.push(
      row(["Employee", "Date", "Project number", "Project", "Work order", "Type", "Billable", "Minutes", "Hours", "Status", "Approved by", "Approved on", "Note"]),
    );
    for (const r of result.rows) {
      lines.push(
        row([
          r.employee,
          r.work_date,
          r.project_number,
          r.project_title,
          r.work_order_number,
          r.entry_type,
          r.is_billable ? "Yes" : "No",
          r.minutes,
          hoursText(r.minutes),
          r.status,
          r.approved_by,
          r.approved_on,
          r.note,
        ]),
      );
    }
  }

  return {
    csv: `﻿${lines.join("\r\n")}\r\n`,
    filename: `hours_${from}_${to}${String(params.group) === "employee" ? "_per-employee" : ""}.csv`,
  };
};

export const HoursService = {
  getAllEntries,
  getMyEntries,
  createEntry,
  updateEntry,
  deleteEntry,
  getTimer,
  startTimer,
  stopTimer,
  discardTimer,
  getBookableProjects,
  getWeek,
  approve,
  rejectEntry,
  unapproveEntry,
  getBillableForProject,
  exportCsv,
};
