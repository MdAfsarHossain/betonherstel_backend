import { announceProject } from "../chat/chat.live";
import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import assertUuid from "../../utils/assertUuid";
import { amsterdamToday, isValidDay } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { formatWhen } from "../../utils/formatters";
import { TLanguage, toLanguage } from "../../utils/i18n";
import { buildIcs } from "../../utils/ical";
import normalizePostcode from "../../utils/normalizePostcode";
import { navigationUrl } from "../../utils/navigation";
import { InquiryService } from "../inquiry/inquiry.service";
import { notify, officeUserIds } from "../messages/notification.shared";
import { RelationService } from "../relation/relation.service";
import { SettingsService } from "../settings/settings.service";
import {
  appointmentStatuses,
  appointmentTypeLabels,
  appointmentTypes,
  assignableRoles,
  IAppointmentAddress,
  ICreateAppointment,
  IUpdateAppointment,
  TAppointmentStatus,
  TAppointmentType,
} from "./planning.interface";

// Planning (SRS 4.9). Appointments for inspections, project work, maintenance visits
// and internal matters, with one or more employees each. The calendar views are
// drawn by the frontend from the range queries here; a drag-and-drop is a PATCH
// with the new times. Double-booking never blocks: it is reported as a warning.

const MAX_RANGE_DAYS = 120;
const customerTypes = ["PRIVATE", "BUSINESS", "VVE"];

const clean = (value: any) =>
  typeof value === "string"
    ? value.trim() === ""
      ? null
      : value.trim()
    : (value ?? null);

const run = (client?: any) => (client ? client.query.bind(client) : query);

const normalizeAddress = (address: IAppointmentAddress) => ({
  street: address.street.trim(),
  house_number: address.house_number.trim(),
  postcode: normalizePostcode(address.postcode),
  city: address.city.trim(),
  country: (address.country ?? "NL").toUpperCase(),
});

const assertTimes = (startsAt: Date, endsAt: Date) => {
  if (!(endsAt.getTime() > startsAt.getTime())) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "The end must be after the start!",
    );
  }
  if (endsAt.getTime() - startsAt.getTime() > 366 * 86_400_000) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "An appointment can last at most 366 days!",
    );
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const assigneesJson = `COALESCE((
    SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'role', u.role) ORDER BY u.name)
    FROM appointment_assignees aa JOIN users u ON u.id = aa.user_id
    WHERE aa.appointment_id = a.id
  ), '[]'::json) AS assignees`;

// Someone is on two overlapping appointments (FR-PLAN-05)
const hasConflict = `(
    a.status <> 'CANCELLED' AND EXISTS (
      SELECT 1
      FROM appointment_assignees x
      JOIN appointment_assignees y ON y.user_id = x.user_id AND y.appointment_id <> x.appointment_id
      JOIN appointments b ON b.id = y.appointment_id
      WHERE x.appointment_id = a.id AND b.status <> 'CANCELLED'
        AND b.starts_at < a.ends_at AND b.ends_at > a.starts_at
    )
  ) AS has_conflict`;

const listColumns = `
  a.id, a.type, a.status, a.title, a.starts_at, a.ends_at, a.all_day, a.city,
  ${hasConflict},
  CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object('id', r.id, 'name', r.name) END AS relation,
  CASE WHEN i.id IS NULL THEN NULL ELSE json_build_object('id', i.id, 'reference', i.reference) END AS inquiry,
  CASE WHEN pj.id IS NULL THEN NULL ELSE json_build_object('id', pj.id, 'number', pj.number, 'title', pj.title) END AS project,
  ${assigneesJson}
`;

const detailColumns = `
  a.id, a.type, a.status, a.title, a.starts_at, a.ends_at, a.all_day,
  a.relation_id, a.inquiry_id, a.project_id,
  a.street, a.house_number, a.postcode, a.city, a.country,
  a.notes, a.confirmation_sent_at,
  (a.confirmation_sent_at IS NOT NULL
     AND (a.confirmed_starts_at IS DISTINCT FROM a.starts_at OR a.confirmed_ends_at IS DISTINCT FROM a.ends_at)
  ) AS confirmation_outdated,
  a.created_by, a.created_at AS "createdAt", a.updated_at AS "updatedAt",
  ${hasConflict},
  CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object('id', r.id, 'name', r.name, 'type', r.type) END AS relation,
  CASE WHEN i.id IS NULL THEN NULL ELSE json_build_object('id', i.id, 'reference', i.reference) END AS inquiry,
  CASE WHEN pj.id IS NULL THEN NULL ELSE json_build_object('id', pj.id, 'number', pj.number, 'title', pj.title) END AS project,
  CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
    'name', COALESCE(pj.contact_name, i.contact_name, pc.name, r.name),
    'phone', COALESCE(pj.contact_phone, i.contact_phone, pc.phone, r.phone),
    'email', COALESCE(pj.contact_email, i.contact_email, pc.email, r.email)
  ) END AS contact,
  ${assigneesJson}
`;

const joins = `
  LEFT JOIN relations r ON r.id = a.relation_id
  LEFT JOIN inquiries i ON i.id = a.inquiry_id
  LEFT JOIN projects pj ON pj.id = a.project_id
`;

const detailJoins = `${joins}
  LEFT JOIN relation_contacts pc ON pc.relation_id = r.id AND pc.is_primary
`;

interface IConflict {
  user: { id: string; name: string };
  appointment: {
    id: string;
    title: string;
    type: string;
    starts_at: Date;
    ends_at: Date;
  };
}

// Which of these people already have something planned in that time?
const findConflicts = async (
  userIds: string[],
  startsAt: string | Date,
  endsAt: string | Date,
  excludeId?: string | null,
  client?: any,
): Promise<IConflict[]> => {
  if (userIds.length === 0) return [];

  const result = await run(client)(
    `
      SELECT aa.user_id, u.name AS user_name,
             b.id AS appointment_id, b.title, b.type, b.starts_at, b.ends_at
      FROM appointment_assignees aa
      JOIN appointments b ON b.id = aa.appointment_id
      JOIN users u ON u.id = aa.user_id
      WHERE aa.user_id = ANY($1::uuid[]) AND b.status <> 'CANCELLED'
        AND b.starts_at < $3::timestamptz AND b.ends_at > $2::timestamptz
        AND ($4::uuid IS NULL OR b.id <> $4::uuid)
      ORDER BY u.name ASC, b.starts_at ASC
    `,
    [
      userIds,
      new Date(startsAt).toISOString(),
      new Date(endsAt).toISOString(),
      excludeId ?? null,
    ],
  );

  return result.rows.map((r: any) => ({
    user: { id: r.user_id, name: r.user_name },
    appointment: {
      id: r.appointment_id,
      title: r.title,
      type: r.type,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
    },
  }));
};

const checkConflicts = async (input: {
  assignee_ids: string[];
  starts_at: string;
  ends_at: string;
  exclude_appointment_id?: string;
}) =>
  findConflicts(
    [...new Set(input.assignee_ids)],
    input.starts_at,
    input.ends_at,
    input.exclude_appointment_id,
  );

// One appointment with everything, plus the people it double-books
const getAppointmentById = async (id: string, client?: any) => {
  assertUuid(id, "appointment id");
  const q = run(client);

  const result = await q(
    `SELECT ${detailColumns} FROM appointments a ${detailJoins} WHERE a.id = $1::uuid`,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Appointment not found!");
  }

  const appointment = result.rows[0];
  const conflicts =
    appointment.status === "CANCELLED"
      ? []
      : await findConflicts(
          appointment.assignees.map((u: any) => u.id),
          appointment.starts_at,
          appointment.ends_at,
          id,
          client,
        );

  return {
    ...appointment,
    navigation_url: navigationUrl(appointment),
    conflicts,
  };
};

// The people who can be put on an appointment.
// Filters: ?role=OFFICE or ?role=OFFICE,FIELD (ADMIN, OFFICE, FIELD) and ?search= (part of the name; ?searchTerm= works too)
const getEmployees = async (params: Record<string, any> = {}) => {
  let roles = assignableRoles;
  if (params.role !== undefined && String(params.role).trim() !== "") {
    roles = asList(params.role).map((r) => r.toUpperCase());
    const unknown = roles.filter((r) => !assignableRoles.includes(r));
    if (unknown.length > 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Role should be one of ${assignableRoles.join(", ")}!`,
      );
    }
  }

  const values: any[] = [roles];
  let search = "";
  // ?search= (also accepted as ?searchTerm=, like the other lists)
  const rawSearch = params.search ?? params.searchTerm ?? "";
  const term = String(
    Array.isArray(rawSearch) ? rawSearch[0] : rawSearch,
  ).trim();
  if (term) {
    values.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    search = `AND name ILIKE $2`;
  }

  const result = await query(
    `
      SELECT id, name, role, avatar, status FROM users
      WHERE is_active AND status = 'ACTIVE' AND role::text = ANY($1::text[]) ${search}
      ORDER BY LOWER(name) ASC, id ASC
    `,
    values,
  );
  return result.rows;
};

// ---------------------------------------------------------------------------
// Range queries: the calendar's day / week / month views (FR-PLAN-01)
// ---------------------------------------------------------------------------

const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isInstant = (v: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(
    v,
  ) && !Number.isNaN(Date.parse(v));

// `from` and `to` are either a date ("2026-11-16": the whole Amsterdam day, so `to`
// includes that day) or a date-time with a time zone. An appointment is in the
// range when it overlaps it; one that merely touches the edge is not.
const parseRange = (fromParam: any, toParam: any, maxDays = MAX_RANGE_DAYS) => {
  const from = String(
    Array.isArray(fromParam) ? fromParam[0] : (fromParam ?? ""),
  ).trim();
  const to = String(
    Array.isArray(toParam) ? toParam[0] : (toParam ?? ""),
  ).trim();

  if (!from || !to) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "from and to are required (a date like 2026-11-16, or a date-time)!",
    );
  }
  for (const [name, value] of [
    ["from", from],
    ["to", to],
  ]) {
    if (!(isDateOnly(value) ? isValidDay(value) : isInstant(value))) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${name} must be a date like 2026-11-16 or a date-time with a time zone!`,
      );
    }
  }

  // Rough milliseconds, only to check the order and the length of the range
  const fromMs = isDateOnly(from)
    ? Date.parse(`${from}T00:00:00Z`)
    : Date.parse(from);
  const toMs = isDateOnly(to)
    ? Date.parse(`${to}T00:00:00Z`) + 86_400_000
    : Date.parse(to);
  if (toMs <= fromMs) {
    throw new ApiError(httpStatus.BAD_REQUEST, "to must be after from!");
  }
  if (toMs - fromMs > maxDays * 86_400_000) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `The range can be at most ${maxDays} days!`,
    );
  }

  return { from, to, fromIsDate: isDateOnly(from), toIsDate: isDateOnly(to) };
};

// SQL for "overlaps the range", with the two parameters at positions p and p + 1
const rangeCondition = (
  r: ReturnType<typeof parseRange>,
  p: number,
  alias = "a",
) =>
  `${alias}.ends_at > ${
    r.fromIsDate
      ? `(($${p}::date)::timestamp AT TIME ZONE 'Europe/Amsterdam')`
      : `$${p}::timestamptz`
  } AND ${alias}.starts_at < ${
    r.toIsDate
      ? `((($${p + 1}::date + 1)::timestamp) AT TIME ZONE 'Europe/Amsterdam')`
      : `$${p + 1}::timestamptz`
  }`;

const asList = (value: any): string[] =>
  String(Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

// The appointments in a date range, for the calendar views
const getAppointments = async (
  params: Record<string, any>,
  actorId: string,
) => {
  const range = parseRange(params.from, params.to);

  const conditions: string[] = [rangeCondition(range, 1)];
  const values: any[] = [range.from, range.to];
  let n = 3;

  if (params.type) {
    const types = asList(params.type).map((t) => t.toUpperCase());
    if (
      types.some((t) => !(appointmentTypes as readonly string[]).includes(t))
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Invalid appointment type!");
    }
    conditions.push(`a.type::text = ANY($${n++}::text[])`);
    values.push(types);
  }

  if (params.status) {
    const statuses = asList(params.status).map((s) => s.toUpperCase());
    if (
      statuses.some(
        (s) => !(appointmentStatuses as readonly string[]).includes(s),
      )
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Invalid status!");
    }
    conditions.push(`a.status::text = ANY($${n++}::text[])`);
    values.push(statuses);
  } else if (String(params.include_cancelled) !== "true") {
    conditions.push(`a.status <> 'CANCELLED'`);
  }

  if (params.assignee) {
    const who = String(params.assignee);
    if (who === "none") {
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM appointment_assignees x WHERE x.appointment_id = a.id)`,
      );
    } else {
      const id = who === "me" ? actorId : who;
      assertUuid(id, "user id");
      conditions.push(
        `EXISTS (SELECT 1 FROM appointment_assignees x WHERE x.appointment_id = a.id AND x.user_id = $${n++}::uuid)`,
      );
      values.push(id);
    }
  }

  for (const [param, column] of [
    ["relation_id", "a.relation_id"],
    ["inquiry_id", "a.inquiry_id"],
    ["project_id", "a.project_id"],
  ] as const) {
    if (params[param]) {
      assertUuid(String(params[param]), param.replace("_", " "));
      conditions.push(`${column} = $${n++}::uuid`);
      values.push(String(params[param]));
    }
  }

  const result = await query(
    `
      SELECT ${listColumns}
      FROM appointments a ${joins}
      WHERE ${conditions.join(" AND ")}
      ORDER BY a.starts_at ASC, a.id ASC
    `,
    values,
  );
  return result.rows;
};

// Resource view (FR-PLAN-01): one row per employee, each with their appointments.
// An appointment with several people appears in each of their rows; one with
// nobody assigned yet is under "unassigned".
const getResourceView = async (
  params: Record<string, any>,
  actorId: string,
) => {
  const appointments = await getAppointments(
    { ...params, assignee: undefined },
    actorId,
  );
  let employees = await getEmployees();

  if (params.user_ids) {
    const wanted = new Set(asList(params.user_ids));
    employees = employees.filter((e) => wanted.has(e.id));
  }

  return {
    employees: employees.map((e) => ({
      ...e,
      appointments: appointments.filter((a: any) =>
        a.assignees.some((u: any) => u.id === e.id),
      ),
    })),
    unassigned: appointments.filter((a: any) => a.assignees.length === 0),
  };
};

// What the field crew sees on their phone (FR-PLAN-06): their own appointments with
// the address, a navigation link and contact details. No prices, nothing about
// other people's jobs. Defaults to today.
const getMySchedule = async (userId: string, params: Record<string, any>) => {
  const today = amsterdamToday();
  const range = parseRange(
    params.from ?? today,
    params.to ?? params.from ?? today,
  );

  const conditions = [`mine.user_id = $3::uuid`, rangeCondition(range, 1)];
  if (String(params.include_cancelled) !== "true")
    conditions.push(`a.status <> 'CANCELLED'`);

  const result = await query(
    `
      SELECT a.id, a.type, a.status, a.title, a.starts_at, a.ends_at, a.all_day, a.notes,
             a.street, a.house_number, a.postcode, a.city, a.country,
             CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
               'name', r.name,
               'contact_name', COALESCE(pj.contact_name, i.contact_name, pc.name, r.name),
               'contact_phone', COALESCE(pj.contact_phone, i.contact_phone, pc.phone, r.phone),
               'contact_email', COALESCE(pj.contact_email, i.contact_email, pc.email, r.email)
             ) END AS customer,
             CASE WHEN pj.id IS NULL THEN NULL ELSE json_build_object('id', pj.id, 'number', pj.number, 'title', pj.title) END AS project,
             COALESCE((
               SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
               FROM appointment_assignees aa JOIN users u ON u.id = aa.user_id
               WHERE aa.appointment_id = a.id AND aa.user_id <> $3::uuid
             ), '[]'::json) AS colleagues,
             COALESCE((
               SELECT json_agg(json_build_object('id', w.id, 'number', w.number, 'status', w.status) ORDER BY w.created_at)
               FROM work_orders w JOIN work_order_assignees wa ON wa.work_order_id = w.id AND wa.user_id = $3::uuid
               WHERE w.appointment_id = a.id
             ), '[]'::json) AS work_orders
      FROM appointments a
      JOIN appointment_assignees mine ON mine.appointment_id = a.id
      ${detailJoins}
      WHERE ${conditions.join(" AND ")}
      ORDER BY a.starts_at ASC, a.id ASC
    `,
    [range.from, range.to, userId],
  );

  return result.rows.map((a: any) => ({
    id: a.id,
    type: a.type,
    status: a.status,
    title: a.title,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    all_day: a.all_day,
    notes: a.notes,
    address: a.street
      ? {
          street: a.street,
          house_number: a.house_number,
          postcode: a.postcode,
          city: a.city,
          country: a.country,
        }
      : null,
    navigation_url: navigationUrl(a),
    customer: a.customer,
    project: a.project,
    work_orders: a.work_orders,
    colleagues: a.colleagues,
  }));
};

// ---------------------------------------------------------------------------
// Helpers for writing
// ---------------------------------------------------------------------------

// Everyone on the list must exist and be an active office or field user
const assertAssignees = async (ids: string[] | undefined) => {
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) return unique;

  const found = await query(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`,
    [unique, assignableRoles],
  );
  if (found.rows.length !== unique.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Only active office and field employees can be assigned!",
    );
  }
  return unique;
};

const replaceAssignees = async (
  client: any,
  appointmentId: string,
  ids: string[],
) => {
  await client.query(
    `DELETE FROM appointment_assignees WHERE appointment_id = $1::uuid`,
    [appointmentId],
  );
  if (ids.length > 0) {
    await client.query(
      `INSERT INTO appointment_assignees (appointment_id, user_id) SELECT $1::uuid, UNNEST($2::uuid[])`,
      [appointmentId, ids],
    );
  }
};

// Who a confirmation goes to: the inquiry's contact, else the customer's primary contact
const customerContact = async (
  relationId: string | null,
  inquiryId: string | null,
  projectId: string | null = null,
  client?: any,
) => {
  if (!relationId) return null;
  const result = await run(client)(
    `
      SELECT r.name AS relation_name,
             COALESCE(pj.contact_name, i.contact_name, pc.name, r.name) AS name,
             COALESCE(pj.contact_email, i.contact_email, pc.email, r.email) AS email,
             COALESCE(i.language::text, r.preferred_language::text) AS language
      FROM relations r
      LEFT JOIN inquiries i ON i.id = $2::uuid
      LEFT JOIN projects pj ON pj.id = $3::uuid
      LEFT JOIN relation_contacts pc ON pc.relation_id = r.id AND pc.is_primary
      WHERE r.id = $1::uuid
    `,
    [relationId, inquiryId, projectId],
  );
  return result.rows[0] ?? null;
};

// What happened, on the customer's timeline (appointments for the office itself have no customer)
const logAppointmentEvent = (
  client: any,
  appointment: { id: string; relation_id: string | null },
  eventType: string,
  title: string,
  actorId: string | null,
  extra: { description?: string | null; metadata?: Record<string, any> } = {},
) =>
  appointment.relation_id
    ? RelationService.logRelationEvent(
        appointment.relation_id,
        {
          event_type: eventType,
          entity_type: "appointment",
          entity_id: appointment.id,
          title,
          description: extra.description ?? null,
          metadata: extra.metadata,
          actor_id: actorId,
        },
        client,
      )
    : Promise.resolve();

const describeWhen = (a: { starts_at: any; ends_at: any; all_day: boolean }) =>
  formatWhen(new Date(a.starts_at), new Date(a.ends_at), a.all_day, "EN");

// The project an appointment is linked to: it must exist and not be closed
const loadLinkableProject = async (projectId: string, client?: any) => {
  assertUuid(projectId, "project id");
  const found = await run(client)(
    `
      SELECT p.id, p.number, p.relation_id, p.closed_at,
             p.street, p.house_number, p.postcode, p.city, p.country
      FROM projects p WHERE p.id = $1::uuid
    `,
    [projectId],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }
  if (found.rows[0].closed_at) {
    throw new ApiError(
      httpStatus.CONFLICT,
      "This project is closed. Reopen it before planning more work!",
    );
  }
  return found.rows[0];
};

// ---------------------------------------------------------------------------
// Creating (FR-PLAN-02, FR-PLAN-04, FR-REQ-04)
// ---------------------------------------------------------------------------

// Plans an appointment. For a site inspection linked to an inquiry (FR-REQ-04) the
// inquiry's customer and address are used and the inquiry moves to "Schouw gepland".
// The response lists any double-booking as `conflicts`: a warning, not an error.
// Tells the people put on an appointment that it is theirs (what, when, where). Called AFTER the
// appointment is saved; the planner is never told about their own action, and it never throws.
const notifyAssigned = async (appointment: any, userIds: string[], actorId: string | null) => {
  try {
    if (userIds.length === 0 || appointment.status === "CANCELLED") return;
    const where = [appointment.street, appointment.house_number, appointment.postcode, appointment.city]
      .filter(Boolean)
      .join(" ");
    const when = describeWhen(appointment);
    await notify(userIds, {
      type: "APPOINTMENT_ASSIGNED",
      title: `${appointmentTypeLabels[appointment.type as TAppointmentType].EN} planned for you: ${appointment.title}`,
      body: [when, appointment.relation?.name, where].filter(Boolean).join(" · "),
      entity: { type: "appointment", id: appointment.id },
      actorId,
    });
  } catch (error: any) {
    console.error("❌ Appointment notification failed:", error?.message ?? error);
  }
};

// Tells the people already on an appointment that its time changed (from when, to when). Called AFTER
// the change is saved; whoever made the change is never told, and it never throws.
const notifyRescheduled = async (
  appointment: any,
  userIds: string[],
  before: { starts_at: any; ends_at: any; all_day: boolean },
  actorId: string | null,
) => {
  try {
    if (userIds.length === 0 || appointment.status === "CANCELLED") return;
    const where = [appointment.street, appointment.house_number, appointment.postcode, appointment.city]
      .filter(Boolean)
      .join(" ");
    await notify(userIds, {
      type: "APPOINTMENT_RESCHEDULED",
      title: `${appointmentTypeLabels[appointment.type as TAppointmentType].EN} moved: ${appointment.title}`,
      body: [
        `Now: ${describeWhen(appointment)}`,
        `Was: ${describeWhen(before)}`,
        appointment.relation?.name,
        where,
      ]
        .filter(Boolean)
        .join(" · "),
      entity: { type: "appointment", id: appointment.id },
      actorId,
    });
  } catch (error: any) {
    console.error("❌ Appointment reschedule notification failed:", error?.message ?? error);
  }
};

// Tells everyone on an appointment that it was cancelled (and why). Called AFTER the status is saved;
// whoever cancelled it is never told, and it never throws.
const notifyCancelled = async (appointment: any, reason: string | null, actorId: string | null) => {
  try {
    const userIds: string[] = (appointment.assignees ?? []).map((a: any) => a.id).filter(Boolean);
    if (userIds.length === 0) return;
    const where = [appointment.street, appointment.house_number, appointment.postcode, appointment.city]
      .filter(Boolean)
      .join(" ");
    await notify(userIds, {
      type: "APPOINTMENT_CANCELLED",
      title: `${appointmentTypeLabels[appointment.type as TAppointmentType].EN} cancelled: ${appointment.title}`,
      body: [describeWhen(appointment), appointment.relation?.name, where, reason ? `Reason: ${reason}` : null]
        .filter(Boolean)
        .join(" · "),
      entity: { type: "appointment", id: appointment.id },
      actorId,
    });
  } catch (error: any) {
    console.error("❌ Appointment cancel notification failed:", error?.message ?? error);
  }
};

const createAppointment = async (
  input: ICreateAppointment,
  actorId: string,
) => {
  const startsAt = new Date(input.starts_at);
  const endsAt = new Date(input.ends_at);
  assertTimes(startsAt, endsAt);

  let inquiry: any = null;
  if (input.inquiry_id) {
    assertUuid(input.inquiry_id, "inquiry id");
    const found = await query(
      `SELECT id, reference, relation_id, street, house_number, postcode, city, country
       FROM inquiries WHERE id = $1::uuid`,
      [input.inquiry_id],
    );
    if (found.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Inquiry not found!");
    }
    inquiry = found.rows[0];
    if (input.relation_id && input.relation_id !== inquiry.relation_id) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "This inquiry belongs to another customer!",
      );
    }
  }

  // A project appointment: the project's customer and address are used (FR-PRJ-07)
  let project: any = null;
  if (input.project_id) {
    project = await loadLinkableProject(input.project_id);
  }

  const relationId = (input.relation_id ??
    project?.relation_id ??
    inquiry?.relation_id ??
    null) as string | null;
  if (project) {
    if (input.type === "INTERNAL") {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "An internal appointment cannot belong to a project!",
      );
    }
    if (project.relation_id !== relationId) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "This project belongs to another customer!",
      );
    }
  }

  if (input.type === "INTERNAL") {
    if (relationId) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "An internal appointment is not linked to a customer!",
      );
    }
  } else if (!relationId) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "This appointment needs a customer (relation_id or inquiry_id)!",
    );
  }

  let relation: any = null;
  if (relationId) {
    assertUuid(relationId, "relation id");
    const found = await query(
      `SELECT id, type, name, preferred_language, is_active FROM relations WHERE id = $1::uuid`,
      [relationId],
    );
    if (found.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Relation not found!");
    }
    relation = found.rows[0];
    if (!relation.is_active) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "This relation is deactivated!",
      );
    }
    if (!customerTypes.includes(relation.type)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "An appointment can only be planned for a customer!",
      );
    }
  }

  const assigneeIds = await assertAssignees(input.assignee_ids);

  const address =
    input.address !== undefined
      ? input.address
        ? normalizeAddress(input.address)
        : null
      : project?.street
        ? normalizeAddress({
            street: project.street,
            house_number: project.house_number,
            postcode: project.postcode,
            city: project.city,
            country: project.country,
          })
        : inquiry?.street
          ? normalizeAddress({
              street: inquiry.street,
              house_number: inquiry.house_number,
              postcode: inquiry.postcode,
              city: inquiry.city,
              country: inquiry.country,
            })
          : null;

  // Asked for a confirmation: check there is somewhere to send it before anything is saved
  let contact: any = null;
  if (input.send_confirmation) {
    if (input.type === "INTERNAL") {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "An internal appointment has no customer to confirm to!",
      );
    }
    contact = await customerContact(
      relationId,
      inquiry?.id ?? null,
      project?.id ?? null,
    );
    if (!contact?.email) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "There is no email address to send the confirmation to!",
      );
    }
  }

  const language = toLanguage(
    contact?.language ?? relation?.preferred_language,
  );
  const title =
    clean(input.title) ??
    (relation
      ? `${appointmentTypeLabels[input.type][language]} - ${relation.name}`
      : appointmentTypeLabels[input.type][language]);

  const appointmentId = await transaction(async (client) => {
    const created = await client.query(
      `
        INSERT INTO appointments (
            type, title, starts_at, ends_at, all_day, relation_id, inquiry_id,
            street, house_number, postcode, city, country, notes, created_by, project_id
        ) VALUES (
            $1::"AppointmentType", $2, $3::timestamptz, $4::timestamptz, $5, $6::uuid, $7::uuid,
            $8, $9, $10, $11, COALESCE($12, 'NL'), $13, $14::uuid, $15::uuid
        )
        RETURNING id
      `,
      [
        input.type,
        title.slice(0, 255),
        startsAt.toISOString(),
        endsAt.toISOString(),
        input.all_day === true,
        relationId,
        inquiry?.id ?? null,
        address?.street ?? null,
        address?.house_number ?? null,
        address?.postcode ?? null,
        address?.city ?? null,
        address?.country ?? null,
        clean(input.notes),
        actorId,
        project?.id ?? null,
      ],
    );
    const id = created.rows[0].id as string;

    await replaceAssignees(client, id, assigneeIds);

    await logAppointmentEvent(
      client,
      { id, relation_id: relationId },
      "APPOINTMENT_PLANNED",
      `${appointmentTypeLabels[input.type].EN} planned: ${describeWhen({ starts_at: startsAt, ends_at: endsAt, all_day: input.all_day === true })}`,
      actorId,
      { metadata: { type: input.type, project_id: project?.id ?? null } },
    );

    // FR-REQ-04: a planned inspection moves the inquiry on
    if (input.type === "INSPECTION" && inquiry) {
      await InquiryService.moveStatusFromPlanning(client, inquiry.id, actorId);
    }

    return id;
  });

  if (input.send_confirmation) {
    await deliverConfirmation(appointmentId, null, actorId);
  }

  const created = await getAppointmentById(appointmentId);
  // Everyone put on it is told (FR-PLAN: the crew sees it in their notifications)
  await notifyAssigned(created, assigneeIds, actorId);
  // Crew planned on a project join its internal chat: their chat list updates live
  await announceProject(created.project_id, { includeCrewLoss: true });
  return created;
};

// ---------------------------------------------------------------------------
// Editing, moving, status (FR-PLAN-03)
// ---------------------------------------------------------------------------

// The crew marks their OWN appointment as done (the phone's "I'm finished" button). Only that: a
// crew member cannot reopen, cancel or move it, and someone else's appointment answers 404 like one
// that does not exist. A repeat (a phone retrying) is answered as done, nothing happens twice.
// The office is told: the person who planned it, else the whole office.
const completeMyAppointment = async (id: string, userId: string, payload: { note?: string }) => {
  assertUuid(id, "appointment id");
  const mine = await query(
    `
      SELECT a.id, a.type, a.status, a.title, a.starts_at, a.created_by
      FROM appointments a
      JOIN appointment_assignees aa ON aa.appointment_id = a.id AND aa.user_id = $2::uuid
      WHERE a.id = $1::uuid
    `,
    [id, userId],
  );
  if (mine.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Appointment not found!");
  }
  const appointment = mine.rows[0];

  if (appointment.status === "CANCELLED") {
    throw new ApiError(httpStatus.CONFLICT, "This appointment is cancelled!");
  }
  if (appointment.status === "COMPLETED") {
    return { id, title: appointment.title, type: appointment.type, status: "COMPLETED", already_completed: true };
  }
  if (new Date(appointment.starts_at).getTime() > Date.now()) {
    throw new ApiError(httpStatus.BAD_REQUEST, "This appointment has not started yet!");
  }

  try {
    await changeStatus(id, { status: "COMPLETED", reason: payload.note }, userId);
  } catch (error: any) {
    // Two taps at the same moment: the other one won, which is what was asked for
    if (!/already has this status/i.test(String(error?.message))) throw error;
    return { id, title: appointment.title, type: appointment.type, status: "COMPLETED", already_completed: true };
  }

  const who = await query(`SELECT name FROM users WHERE id = $1::uuid`, [userId]);
  const planner = appointment.created_by
    ? await query(
        `SELECT id FROM users WHERE id = $1::uuid AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`,
        [appointment.created_by, ["SUPERADMIN", "ADMIN", "OFFICE"]],
      )
    : { rows: [] as any[] };
  const recipients = planner.rows.length > 0 ? [planner.rows[0].id as string] : await officeUserIds();
  await notify(recipients, {
    type: "APPOINTMENT_COMPLETED",
    title: `${appointmentTypeLabels[appointment.type as TAppointmentType].EN} done: ${appointment.title}`,
    body: clean(payload.note) ?? `${who.rows[0]?.name ?? "A crew member"} marked this appointment as done.`,
    entity: { type: "appointment", id },
    actorId: userId,
  });

  return { id, title: appointment.title, type: appointment.type, status: "COMPLETED", already_completed: false };
};

const lockAppointment = async (client: any, id: string) => {
  assertUuid(id, "appointment id");
  const result = await client.query(
    `SELECT id, type, status, title, starts_at, ends_at, all_day, relation_id, inquiry_id, project_id
     FROM appointments WHERE id = $1::uuid FOR UPDATE`,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Appointment not found!");
  }
  return result.rows[0];
};

// Edit an appointment. Moving or resizing it in the calendar sends just the new
// times. The response lists any double-booking as `conflicts`.
const updateAppointment = async (
  id: string,
  payload: IUpdateAppointment,
  actorId: string,
) => {
  const assigneeIds =
    payload.assignee_ids !== undefined
      ? await assertAssignees(payload.assignee_ids)
      : undefined;
  let projectBefore: string | null = null;
  // Who was on it before this change (to tell only the people who are new)
  let assigneesBefore: string[] = [];
  // The time before this change, when this change moved it
  let movedFrom: { starts_at: any; ends_at: any; all_day: boolean } | null = null;

  await transaction(async (client) => {
    const current = await lockAppointment(client, id);
    projectBefore = current.project_id ?? null;
    if (current.status === "CANCELLED") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "A cancelled appointment cannot be changed. Reopen it first!",
      );
    }
    assigneesBefore = (
      await client.query(
        `SELECT user_id FROM appointment_assignees WHERE appointment_id = $1::uuid`,
        [id],
      )
    ).rows.map((r: any) => r.user_id as string);

    // A customer appointment stays a customer appointment and an internal one stays internal
    if (
      payload.type !== undefined &&
      (payload.type === "INTERNAL") !== (current.type === "INTERNAL")
    ) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "An internal appointment cannot become a customer appointment, or the other way round!",
      );
    }

    const startsAt = payload.starts_at
      ? new Date(payload.starts_at)
      : new Date(current.starts_at);
    const endsAt = payload.ends_at
      ? new Date(payload.ends_at)
      : new Date(current.ends_at);
    assertTimes(startsAt, endsAt);
    const rescheduled =
      startsAt.getTime() !== new Date(current.starts_at).getTime() ||
      endsAt.getTime() !== new Date(current.ends_at).getTime();

    const data: Record<string, any> = {};
    if (payload.type !== undefined) data.type = payload.type;
    if (payload.title !== undefined)
      data.title = clean(payload.title)?.slice(0, 255);
    if (payload.all_day !== undefined) data.all_day = payload.all_day;
    if (payload.notes !== undefined) data.notes = clean(payload.notes);
    if (payload.project_id !== undefined) {
      if (payload.project_id === null) {
        data.project_id = null;
      } else if (payload.project_id !== current.project_id) {
        const project = await loadLinkableProject(payload.project_id, client);
        if ((payload.type ?? current.type) === "INTERNAL") {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            "An internal appointment cannot belong to a project!",
          );
        }
        if (project.relation_id !== current.relation_id) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            "This project belongs to another customer!",
          );
        }
        data.project_id = project.id;
      }
    }
    if (rescheduled) {
      data.starts_at = startsAt.toISOString();
      data.ends_at = endsAt.toISOString();
    }
    if (payload.address !== undefined) {
      const a = payload.address ? normalizeAddress(payload.address) : null;
      data.street = a?.street ?? null;
      data.house_number = a?.house_number ?? null;
      data.postcode = a?.postcode ?? null;
      data.city = a?.city ?? null;
      data.country = a?.country ?? "NL";
    }

    if (Object.keys(data).length === 0 && assigneeIds === undefined) {
      throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
    }

    const casts: Record<string, string> = {
      type: '::"AppointmentType"',
      starts_at: "::timestamptz",
      ends_at: "::timestamptz",
      project_id: "::uuid",
    };
    const updates: string[] = [];
    const values: any[] = [];
    let n = 1;
    for (const [field, value] of Object.entries(data)) {
      updates.push(`${field} = $${n++}${casts[field] ?? ""}`);
      values.push(value);
    }
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    await client.query(
      `UPDATE appointments SET ${updates.join(", ")} WHERE id = $${n}::uuid`,
      values,
    );

    if (assigneeIds !== undefined)
      await replaceAssignees(client, id, assigneeIds);

    if (rescheduled) {
      movedFrom = {
        starts_at: current.starts_at,
        ends_at: current.ends_at,
        all_day: current.all_day,
      };
      await logAppointmentEvent(
        client,
        current,
        "APPOINTMENT_RESCHEDULED",
        `${appointmentTypeLabels[(payload.type ?? current.type) as TAppointmentType].EN} moved to ${describeWhen({ starts_at: startsAt, ends_at: endsAt, all_day: payload.all_day ?? current.all_day })}`,
        actorId,
        {
          metadata: {
            from: { starts_at: current.starts_at, ends_at: current.ends_at },
            to: {
              starts_at: startsAt.toISOString(),
              ends_at: endsAt.toISOString(),
            },
          },
        },
      );
    }
  });

  const updated = await getAppointmentById(id);
  // People added by this change are told it is theirs (with the new time); those taken off are not told
  const assigneesAfter = assigneeIds ?? assigneesBefore;
  if (assigneeIds !== undefined) {
    await notifyAssigned(
      updated,
      assigneeIds.filter((userId) => !assigneesBefore.includes(userId)),
      actorId,
    );
  }
  // People who were already on it and still are hear that the time changed
  if (movedFrom) {
    await notifyRescheduled(
      updated,
      assigneesAfter.filter((userId) => assigneesBefore.includes(userId)),
      movedFrom,
      actorId,
    );
  }
  // The crew on the project (before and after the change) see their chat list update live
  await announceProject(projectBefore, { includeCrewLoss: true });
  if (updated.project_id !== projectBefore)
    await announceProject(updated.project_id, { includeCrewLoss: true });
  return updated;
};

// Complete, cancel or reopen an appointment
const changeStatus = async (
  id: string,
  payload: { status: TAppointmentStatus; reason?: string },
  actorId: string,
) => {
  await transaction(async (client) => {
    const current = await lockAppointment(client, id);
    if (current.status === payload.status) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "The appointment already has this status!",
      );
    }

    await client.query(
      `UPDATE appointments SET status = $2::"AppointmentStatus", updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, payload.status],
    );

    const labels: Record<TAppointmentStatus, [string, string]> = {
      PLANNED: ["APPOINTMENT_REOPENED", "reopened"],
      COMPLETED: ["APPOINTMENT_COMPLETED", "completed"],
      CANCELLED: ["APPOINTMENT_CANCELLED", "cancelled"],
    };
    const [eventType, verb] = labels[payload.status as TAppointmentStatus];
    await logAppointmentEvent(
      client,
      current,
      eventType,
      `${appointmentTypeLabels[current.type as TAppointmentType].EN} ${verb}: ${describeWhen(current)}`,
      actorId,
      { description: clean(payload.reason) },
    );
  });

  const changed = await getAppointmentById(id);
  // The people on it hear that it will not happen
  if (payload.status === "CANCELLED") {
    await notifyCancelled(changed, clean(payload.reason) ?? null, actorId);
  }
  // A cancelled appointment no longer puts its crew in the project's chat
  await announceProject(changed.project_id, { includeCrewLoss: true });
  return changed;
};

const deleteAppointment = async (id: string, actorId: string) => {
  let projectId: string | null = null;
  await transaction(async (client) => {
    const current = await lockAppointment(client, id);
    projectId = current.project_id ?? null;
    await client.query(`DELETE FROM appointments WHERE id = $1::uuid`, [id]);
    await logAppointmentEvent(
      client,
      current,
      "APPOINTMENT_DELETED",
      `${appointmentTypeLabels[current.type as TAppointmentType].EN} removed: ${describeWhen(current)}`,
      actorId,
    );
  });
  await announceProject(projectId, { includeCrewLoss: true });
};

// ---------------------------------------------------------------------------
// Confirmation email to the customer (FR-PLAN-07)
// ---------------------------------------------------------------------------

const addressLine = (a: {
  street?: string | null;
  house_number?: string | null;
  postcode?: string | null;
  city?: string | null;
}) =>
  [
    [a.street, a.house_number].filter(Boolean).join(" "),
    [a.postcode, a.city].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");

// Sends the customer the date, time and address with a calendar file attached.
// The email goes out first; the appointment is only marked "confirmed" if it was sent.
const deliverConfirmation = async (
  id: string,
  emailOverride: string | null,
  actorId: string,
) => {
  const appointment = await getAppointmentById(id);

  if (appointment.type === "INTERNAL") {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "An internal appointment has no customer to confirm to!",
    );
  }
  if (appointment.status !== "PLANNED") {
    throw new ApiError(
      httpStatus.CONFLICT,
      "Only a planned appointment can be confirmed!",
    );
  }

  const contact = await customerContact(
    appointment.relation_id,
    appointment.inquiry_id,
    appointment.project_id,
  );
  const email = clean(emailOverride)?.toLowerCase() ?? contact?.email ?? null;
  if (!email) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "There is no email address to send the confirmation to!",
    );
  }

  const language: TLanguage = toLanguage(contact?.language);
  const company = await SettingsService.getCompanySettings();
  const where = addressLine(appointment);
  const typeLabel =
    appointmentTypeLabels[appointment.type as TAppointmentType][language];

  // The customer's calendar file carries no internal notes
  const ics = buildIcs(
    [
      {
        uid: `${appointment.id}@betonherstel`,
        start: new Date(appointment.starts_at),
        end: new Date(appointment.ends_at),
        allDay: appointment.all_day,
        summary: `${typeLabel} - ${company.company_name}`,
        location: where || null,
        description: [company.company_name, company.phone]
          .filter(Boolean)
          .join(" - "),
        status: "CONFIRMED",
        updated: new Date(appointment.updatedAt),
      },
    ],
    company.company_name,
  );

  await sendTemplatedEmail({
    to: email,
    templateKey: "appointment_confirmation",
    language,
    variables: {
      name: contact?.name ?? "",
      appointment_type: typeLabel,
      when: formatWhen(
        new Date(appointment.starts_at),
        new Date(appointment.ends_at),
        appointment.all_day,
        language,
      ),
      address:
        where || (language === "EN" ? "to be announced" : "nog te bepalen"),
      title: appointment.title,
    },
    attachments: [
      {
        filename: "appointment.ics",
        content: Buffer.from(ics, "utf8"),
        contentType: "text/calendar; charset=utf-8; method=PUBLISH",
      },
    ],
    related: { type: "appointment", id },
    sentBy: actorId,
  });

  await transaction(async (client) => {
    await client.query(
      `
        UPDATE appointments
        SET confirmation_sent_at = CURRENT_TIMESTAMP, confirmed_starts_at = starts_at, confirmed_ends_at = ends_at
        WHERE id = $1::uuid
      `,
      [id],
    );
    await logAppointmentEvent(
      client,
      appointment,
      "APPOINTMENT_CONFIRMATION_SENT",
      `Confirmation sent to ${email}`,
      actorId,
    );
  });
};

const sendConfirmation = async (
  id: string,
  email: string | undefined,
  actorId: string,
) => {
  await deliverConfirmation(id, email ?? null, actorId);
  return getAppointmentById(id);
};

export const PlanningService = {
  completeMyAppointment,
  getEmployees,
  getAppointments,
  getResourceView,
  getMySchedule,
  getAppointmentById,
  createAppointment,
  updateAppointment,
  changeStatus,
  deleteAppointment,
  checkConflicts,
  sendConfirmation,
};
