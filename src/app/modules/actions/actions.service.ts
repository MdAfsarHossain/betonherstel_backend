import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { amsterdamToday, isValidDay } from "../../utils/dates";
import { query } from "../../utils/db";
import { assertRecordExists, assertRecordType, recordLabelSql } from "../../utils/records";
import {
  actionAutoTypes,
  actionStatuses,
  IActionEntity,
  IActor,
  ICreateAction,
  IUpdateAction,
} from "./actions.interface";
import { notify } from "../messages/notification.shared";
import { internalRoles, staffRoles } from "./actions.shared";

// Acties (SRS 4.16): tasks with a title, description, due date, assignee and a link to a record
// (FR-MSG-03). Overdue tasks are flagged. The office sees every task; field crew only their own.
// Automatic tasks for key events are made by `createAutomaticAction` (FR-MSG-04).

const todaySql = `(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Amsterdam')::date`;

const isStaff = (actor: IActor) => (staffRoles as readonly string[]).includes(actor.role);

const clean = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : (value ?? null);

const asList = (value: any): string[] =>
  String(Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const assertDay = (value: any, label: string) => {
  const day = String(value);
  if (!isValidDay(day)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${label} must be a date like 2026-11-30!`);
  }
  return day;
};

const entityLabelSql = recordLabelSql("a.entity_type", "a.entity_id");

const columns = `
  a.id, a.title, a.description, a.status, to_char(a.due_date, 'YYYY-MM-DD') AS due_date,
  a.source, a.auto_type, a.completed_at, a.completion_note,
  a.created_at AS "createdAt", a.updated_at AS "updatedAt",
  COALESCE(a.status = 'OPEN' AND a.due_date < ${todaySql}, false) AS is_overdue,
  COALESCE(a.status = 'OPEN' AND a.due_date = ${todaySql}, false) AS is_due_today,
  CASE WHEN a.status = 'OPEN' AND a.due_date < ${todaySql} THEN (${todaySql} - a.due_date)::int ELSE 0 END AS days_overdue,
  CASE WHEN a.assignee_id IS NULL THEN NULL ELSE json_build_object('id', au.id, 'name', au.name) END AS assignee,
  CASE WHEN a.created_by IS NULL THEN NULL ELSE json_build_object('id', cu.id, 'name', cu.name) END AS created_by,
  CASE WHEN a.completed_by IS NULL THEN NULL ELSE json_build_object('id', du.id, 'name', du.name) END AS completed_by,
  CASE WHEN a.entity_type IS NULL THEN NULL ELSE json_build_object('type', a.entity_type, 'id', a.entity_id, 'label', ${entityLabelSql}) END AS entity
`;

const joins = `
  LEFT JOIN users au ON au.id = a.assignee_id
  LEFT JOIN users cu ON cu.id = a.created_by
  LEFT JOIN users du ON du.id = a.completed_by
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const assertAssignee = async (assigneeId: string) => {
  assertUuid(assigneeId, "assignee id");
  const found = await query(
    `SELECT 1 FROM users WHERE id = $1::uuid AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`,
    [assigneeId, [...internalRoles]],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The assignee must be an active employee!");
  }
};

const assertEntity = async (entity: IActionEntity) => {
  await assertRecordExists(entity.type, entity.id);
};

const assertNotPast = (day: string | null | undefined) => {
  if (day && day < amsterdamToday()) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The due date cannot be in the past!");
  }
};

// Field crew work with their own tasks only. "Not yours" answers 404, like "does not exist".
const canSee = (actor: IActor, row: { assignee_id: string | null }) => isStaff(actor) || row.assignee_id === actor.id;

const loadRow = async (id: string) => {
  assertUuid(id, "action id");
  const found = await query(
    `SELECT id, status, source, assignee_id, created_by, entity_type, entity_id, due_date::text AS due_date FROM actions WHERE id = $1::uuid`,
    [id],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Action not found!");
  }
  return found.rows[0];
};

const loadVisible = async (id: string, actor: IActor) => {
  const row = await loadRow(id);
  if (!canSee(actor, row)) {
    throw new ApiError(httpStatus.NOT_FOUND, "Action not found!");
  }
  return row;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const readAction = async (id: string) => {
  const result = await query(`SELECT ${columns} FROM actions a ${joins} WHERE a.id = $1::uuid`, [id]);
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Action not found!");
  }
  return result.rows[0];
};

const getActionById = async (id: string, actor: IActor) => {
  await loadVisible(id, actor);
  return readAction(id);
};

const getAllActions = async (params: Record<string, any>, actor: IActor) => {
  const { page, limit, skip, sortOrder } = paginationHelper.calculatePagination(params as any);

  const conditions: string[] = [];
  const values: any[] = [];
  let n = 1;

  // Field crew: only what is assigned to them, whatever they ask for
  if (!isStaff(actor)) {
    conditions.push(`a.assignee_id = $${n++}::uuid`);
    values.push(actor.id);
  }

  if (params.searchTerm) {
    const term = String(Array.isArray(params.searchTerm) ? params.searchTerm[0] : params.searchTerm)
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(`(a.title ILIKE $${n} OR a.description ILIKE $${n})`);
    values.push(`%${term}%`);
    n++;
  }
  if (params.status) {
    const statuses = asList(params.status).map((s) => s.toUpperCase());
    if (statuses.some((s) => !(actionStatuses as readonly string[]).includes(s))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Status should be OPEN or DONE!");
    }
    conditions.push(`a.status = ANY($${n++}::text[])`);
    values.push(statuses);
  }
  if (params.source) {
    const source = String(params.source).toUpperCase();
    if (!["MANUAL", "AUTOMATIC"].includes(source)) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Source should be MANUAL or AUTOMATIC!");
    }
    conditions.push(`a.source = $${n++}`);
    values.push(source);
  }
  if (params.auto_type) {
    const types = asList(params.auto_type);
    if (types.some((t) => !(actionAutoTypes as readonly string[]).includes(t))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Unknown automatic task type!");
    }
    conditions.push(`a.auto_type = ANY($${n++}::text[])`);
    values.push(types);
  }
  if (String(params.mine) === "true") {
    conditions.push(`a.assignee_id = $${n++}::uuid`);
    values.push(actor.id);
  }
  if (String(params.unassigned) === "true") {
    conditions.push(`a.assignee_id IS NULL`);
  }
  if (params.assignee_id) {
    const who = String(params.assignee_id);
    if (who === "me") {
      conditions.push(`a.assignee_id = $${n++}::uuid`);
      values.push(actor.id);
    } else {
      assertUuid(who, "assignee id");
      conditions.push(`a.assignee_id = $${n++}::uuid`);
      values.push(who);
    }
  }
  if (String(params.overdue) === "true") {
    conditions.push(`a.status = 'OPEN' AND a.due_date < ${todaySql}`);
  }
  if (String(params.due_today) === "true") {
    conditions.push(`a.status = 'OPEN' AND a.due_date = ${todaySql}`);
  }
  for (const [param, operator] of [
    ["due_from", ">="],
    ["due_to", "<="],
  ] as const) {
    if (params[param]) {
      conditions.push(`a.due_date ${operator} $${n++}::date`);
      values.push(assertDay(params[param], param));
    }
  }
  if (params.entity_type) {
    const type = assertRecordType(String(params.entity_type));
    conditions.push(`a.entity_type = $${n++}`);
    values.push(type);
  }
  if (params.entity_id) {
    assertUuid(String(params.entity_id), "record id");
    conditions.push(`a.entity_id = $${n++}::uuid`);
    values.push(String(params.entity_id));
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // Default order: open tasks first, the most overdue on top, then by due date, undated last
  const sortable: Record<string, string> = {
    due_date: "a.due_date",
    created_at: "a.created_at",
    title: "LOWER(a.title)",
    status: "a.status",
  };
  const direction = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";
  const orderBy =
    typeof params.sortBy === "string" && Object.prototype.hasOwnProperty.call(sortable, params.sortBy)
      ? `${sortable[params.sortBy]} ${direction} NULLS LAST, a.id ASC`
      : `(a.status = 'DONE') ASC, a.due_date ASC NULLS LAST, a.created_at ASC, a.id ASC`;

  const [result, count] = await Promise.all([
    query(`SELECT ${columns} FROM actions a ${joins} ${where} ORDER BY ${orderBy} LIMIT $${n} OFFSET $${n + 1}`, [...values, limit, skip]),
    query(
      `
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE a.status = 'OPEN')::int AS open,
               COUNT(*) FILTER (WHERE a.status = 'OPEN' AND a.due_date < ${todaySql})::int AS overdue
        FROM actions a ${where}
      `,
      values,
    ),
  ]);

  const total = count.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    totals: { actions: total, open: count.rows[0].open, overdue: count.rows[0].overdue },
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

// The numbers for the dashboard tile (FR-DASH-01): mine, and for the office also the whole team
const getSummary = async (actor: IActor) => {
  const mine = await query(
    `
      SELECT COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
             COUNT(*) FILTER (WHERE status = 'OPEN' AND due_date < ${todaySql})::int AS overdue,
             COUNT(*) FILTER (WHERE status = 'OPEN' AND due_date = ${todaySql})::int AS due_today
      FROM actions WHERE assignee_id = $1::uuid
    `,
    [actor.id],
  );
  const result: Record<string, any> = { mine: mine.rows[0] };

  if (isStaff(actor)) {
    const team = await query(
      `
        SELECT COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
               COUNT(*) FILTER (WHERE status = 'OPEN' AND due_date < ${todaySql})::int AS overdue,
               COUNT(*) FILTER (WHERE status = 'OPEN' AND due_date = ${todaySql})::int AS due_today,
               COUNT(*) FILTER (WHERE status = 'OPEN' AND assignee_id IS NULL)::int AS unassigned
        FROM actions
      `,
    );
    result.team = team.rows[0];
  }
  return result;
};

// ---------------------------------------------------------------------------
// Creating and changing (FR-MSG-03)
// ---------------------------------------------------------------------------

// "A task was assigned to you" (never for a task you gave yourself)
const notifyAssigned = (actionId: string, assigneeId: string | null, title: string, dueDate: string | null, actorId: string) =>
  assigneeId
    ? notify([assigneeId], {
        type: "ACTION_ASSIGNED",
        title: `Task assigned to you: ${title}`,
        body: dueDate ? `Due ${dueDate}` : null,
        data: { action_id: actionId },
        actorId,
      })
    : Promise.resolve(0);

const createAction = async (input: ICreateAction, actor: IActor) => {
  assertNotPast(input.due_date);

  // Omitted = the creator. null = nobody yet.
  const assigneeId = input.assignee_id === undefined ? actor.id : input.assignee_id;
  if (!isStaff(actor)) {
    // Field crew keep a to-do list for themselves
    if (assigneeId !== actor.id) {
      throw new ApiError(httpStatus.FORBIDDEN, "You can only create tasks for yourself!");
    }
    if (input.entity) {
      throw new ApiError(httpStatus.FORBIDDEN, "You cannot link a task to a record!");
    }
  }
  if (assigneeId) await assertAssignee(assigneeId);
  if (input.entity) await assertEntity(input.entity);

  const created = await query(
    `
      INSERT INTO actions (title, description, due_date, assignee_id, source, entity_type, entity_id, created_by)
      VALUES ($1, $2, $3::date, $4::uuid, 'MANUAL', $5, $6::uuid, $7::uuid)
      RETURNING id
    `,
    [input.title.trim(), clean(input.description), input.due_date ?? null, assigneeId, input.entity?.type ?? null, input.entity?.id ?? null, actor.id],
  );
  await notifyAssigned(created.rows[0].id, assigneeId, input.title.trim(), input.due_date ?? null, actor.id);
  return readAction(created.rows[0].id);
};

const updateAction = async (id: string, payload: IUpdateAction, actor: IActor) => {
  const row = await loadVisible(id, actor);
  if (row.status === "DONE") {
    throw new ApiError(httpStatus.CONFLICT, "A completed task cannot be changed. Reopen it first!");
  }

  if (!isStaff(actor)) {
    const blocked = Object.keys(payload).filter((k) => !["title", "description", "due_date"].includes(k));
    if (blocked.length > 0) {
      throw new ApiError(httpStatus.FORBIDDEN, `You can only change the title, description and due date (not: ${blocked.join(", ")})!`);
    }
  }
  if (row.source === "AUTOMATIC" && (payload.title !== undefined || payload.entity !== undefined)) {
    throw new ApiError(httpStatus.CONFLICT, "An automatic task keeps its title and its link. You can change the due date, the assignee and the description!");
  }

  // Moving a due date that is already in the past is fine; setting a new one in the past is not
  if (payload.due_date !== undefined && payload.due_date !== row.due_date) assertNotPast(payload.due_date);
  if (payload.assignee_id) await assertAssignee(payload.assignee_id);
  if (payload.entity) await assertEntity(payload.entity);

  const updates: string[] = [];
  const values: any[] = [id];
  let n = 2;
  const set = (column: string, value: any, cast = "") => {
    updates.push(`${column} = $${n++}${cast}`);
    values.push(value);
  };
  if (payload.title !== undefined) set("title", payload.title.trim());
  if (payload.description !== undefined) set("description", clean(payload.description));
  if (payload.due_date !== undefined) set("due_date", payload.due_date, "::date");
  if (payload.assignee_id !== undefined) set("assignee_id", payload.assignee_id, "::uuid");
  if (payload.entity !== undefined) {
    set("entity_type", payload.entity?.type ?? null);
    set("entity_id", payload.entity?.id ?? null, "::uuid");
  }
  updates.push("updated_at = CURRENT_TIMESTAMP");
  await query(`UPDATE actions SET ${updates.join(", ")} WHERE id = $1::uuid`, values);

  // Handed to someone new: they should know
  if (payload.assignee_id && payload.assignee_id !== row.assignee_id) {
    const current = await query(`SELECT title, to_char(due_date, 'YYYY-MM-DD') AS due_date FROM actions WHERE id = $1::uuid`, [id]);
    await notifyAssigned(id, payload.assignee_id, current.rows[0].title, current.rows[0].due_date, actor.id);
  }

  return readAction(id);
};

const completeAction = async (id: string, note: string | null | undefined, actor: IActor) => {
  await loadVisible(id, actor);
  // The status is checked in the UPDATE itself, so two people completing at once do not both win
  const done = await query(
    `
      UPDATE actions SET status = 'DONE', completed_at = CURRENT_TIMESTAMP, completed_by = $2::uuid, completion_note = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid AND status = 'OPEN' RETURNING id
    `,
    [id, actor.id, clean(note)],
  );
  if (done.rows.length === 0) {
    throw new ApiError(httpStatus.CONFLICT, "This task has already been completed!");
  }
  return readAction(id);
};

const reopenAction = async (id: string, actor: IActor) => {
  await loadVisible(id, actor);
  const reopened = await query(
    `
      UPDATE actions SET status = 'OPEN', completed_at = NULL, completed_by = NULL, completion_note = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid AND status = 'DONE' RETURNING id
    `,
    [id],
  );
  if (reopened.rows.length === 0) {
    throw new ApiError(httpStatus.CONFLICT, "This task is not completed!");
  }
  return readAction(id);
};

// Only tasks people made. An automatic task is completed, not deleted, so the event that made it
// does not make another one.
const deleteAction = async (id: string, actor: IActor) => {
  const row = await loadVisible(id, actor);
  if (row.source === "AUTOMATIC") {
    throw new ApiError(httpStatus.CONFLICT, "An automatic task cannot be deleted. Complete it instead!");
  }
  if (!isStaff(actor) && row.created_by !== actor.id) {
    throw new ApiError(httpStatus.FORBIDDEN, "You can only delete tasks you created yourself!");
  }
  await query(`DELETE FROM actions WHERE id = $1::uuid`, [id]);
};

export const ActionService = {
  createAction,
  getAllActions,
  getSummary,
  getActionById,
  updateAction,
  completeAction,
  reopenAction,
  deleteAction,
};
