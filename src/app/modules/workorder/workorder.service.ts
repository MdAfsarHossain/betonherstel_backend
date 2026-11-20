import { announceProject } from "../chat/chat.live";
import httpStatus from "http-status";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { loadLogo } from "../../lib/pdfService";
import { S3Uploader } from "../../lib/S3Uploader";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { amsterdamToday, isValidDay } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { formatDate } from "../../utils/formatters";
import { toLanguage } from "../../utils/i18n";
import { navigationUrl } from "../../utils/navigation";
import normalizePostcode from "../../utils/normalizePostcode";
import { assignableRoles } from "../planning/planning.interface";
import { ProjectService } from "../project/project.service";
import { RelationService } from "../relation/relation.service";
import { notify } from "../messages/notification.shared";
import { SettingsService } from "../settings/settings.service";
import {
  IActor,
  ICompleteWorkOrder,
  ICreateWorkOrder,
  IHourInput,
  IMaterialInput,
  ISignatureInput,
  ISyncWorkOrder,
  IUpdateWorkOrder,
  IWorkOrderAddress,
  IChecklistItemInput,
  workOrderStatuses,
} from "./workorder.interface";
import { buildWorkOrderPdf } from "./workorder.pdf";
import { assertDailyLimit } from "../hours/hours.limits";

// Werkbonnen (SRS 4.10). Office staff create a work order from a project (or a planned
// appointment) with instructions, a checklist, materials and a crew. The crew opens it
// on their phone and records the work, materials used, checklist, hours, photos and the
// customer's signature. Completing it makes a PDF (stored on the project, mailable to
// the customer) and tells the office, who then mark it as checked.

const staffRoles = ["SUPERADMIN", "ADMIN", "OFFICE"];
const isStaff = (actor: IActor) => staffRoles.includes(actor.role);

const MAX_PHOTOS_PER_WORK_ORDER = 100;
const MAX_SIGNATURE_BYTES = 300 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const clean = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : (value ?? null);

const asList = (value: any): string[] =>
  String(Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const normalizeAddress = (a: IWorkOrderAddress) => ({
  street: a.street.trim(),
  house_number: a.house_number.trim(),
  postcode: normalizePostcode(a.postcode),
  city: a.city.trim(),
  country: (a.country ?? "NL").toUpperCase(),
});

const addressLines = (a: { street?: string | null; house_number?: string | null; postcode?: string | null; city?: string | null }) =>
  [[a.street, a.house_number].filter(Boolean).join(" "), [a.postcode, a.city].filter(Boolean).join(" ")].filter(Boolean);

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Locks the row (a single-table select, never a join) so two requests take turns
const lockWorkOrder = async (client: any, id: string) => {
  assertUuid(id, "work order id");
  const result = await client.query(
    `SELECT id, number, title, project_id, appointment_id, status FROM work_orders WHERE id = $1::uuid FOR UPDATE`,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Work order not found!");
  }
  return result.rows[0];
};

// Field crew only reach work orders they are assigned to. "Not yours" and "does not
// exist" give the same answer.
const assertAccess = async (client: any, workOrderId: string, actor: IActor) => {
  if (isStaff(actor)) return;
  const found = await client.query(
    `SELECT 1 FROM work_order_assignees WHERE work_order_id = $1::uuid AND user_id = $2::uuid`,
    [workOrderId, actor.id],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Work order not found!");
  }
};

const projectContext = async (client: any, projectId: string) => {
  const result = await client.query(
    `
      SELECT p.id, p.number, p.title, p.relation_id, p.closed_at, p.project_manager_id,
             p.street, p.house_number, p.postcode, p.city, p.country,
             p.contact_name, p.contact_email, p.contact_phone,
             r.name AS relation_name, r.email AS relation_email, r.preferred_language
      FROM projects p JOIN relations r ON r.id = p.relation_id
      WHERE p.id = $1::uuid
    `,
    [projectId],
  );
  return result.rows[0];
};

const logWorkOrderEvent = (
  client: any,
  workOrder: { id: string },
  relationId: string,
  eventType: string,
  title: string,
  actorId: string | null,
  extra: { description?: string | null; metadata?: Record<string, any> } = {},
) =>
  RelationService.logRelationEvent(
    relationId,
    {
      event_type: eventType,
      entity_type: "work_order",
      entity_id: workOrder.id,
      title,
      description: extra.description ?? null,
      metadata: extra.metadata,
      actor_id: actorId,
    },
    client,
  );

const assertEditable = (workOrder: { status: string }, what = "changed") => {
  if (workOrder.status === "COMPLETED" || workOrder.status === "CHECKED") {
    throw new ApiError(
      httpStatus.CONFLICT,
      `This work order is already completed and cannot be ${what}. Reopen it first!`,
    );
  }
};

// Everyone on the list must exist and be an active office or field user
const assertAssignees = async (ids: string[] | undefined) => {
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) return unique;

  const found = await query(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`,
    [unique, assignableRoles],
  );
  if (found.rows.length !== unique.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Only active office and field employees can be assigned!");
  }
  return unique;
};

const replaceAssignees = async (client: any, workOrderId: string, ids: string[]) => {
  await client.query(`DELETE FROM work_order_assignees WHERE work_order_id = $1::uuid`, [workOrderId]);
  if (ids.length > 0) {
    await client.query(
      `INSERT INTO work_order_assignees (work_order_id, user_id) SELECT $1::uuid, UNNEST($2::uuid[])`,
      [workOrderId, ids],
    );
  }
};

// Fills description and unit from the catalogue where a catalogue item is given
const prepareMaterials = async (items: IMaterialInput[]) => {
  const catalogueItemIds = [...new Set(items.map((m) => m.catalogue_item_id).filter(Boolean) as string[])];
  const catalogueItems = new Map<string, any>();
  if (catalogueItemIds.length > 0) {
    const found = await query(
      `SELECT id, name, description, unit, is_active FROM catalogue_items WHERE id = ANY($1::uuid[])`,
      [catalogueItemIds],
    );
    for (const row of found.rows) catalogueItems.set(row.id, row);
  }

  return items.map((m, i) => {
    const catalogueItem = m.catalogue_item_id ? catalogueItems.get(m.catalogue_item_id) : null;
    if (m.catalogue_item_id && !catalogueItem) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Material ${i + 1}: catalogue item not found!`);
    }
    if (catalogueItem && !catalogueItem.is_active) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Material ${i + 1}: the catalogue item is no longer available!`);
    }
    const description = clean(m.description) ?? catalogueItem?.name;
    const unit = m.unit ?? catalogueItem?.unit;
    if (!description || !unit) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Material ${i + 1}: description and unit are required!`);
    }
    return {
      id: m.id ?? null,
      catalogue_item_id: m.catalogue_item_id ?? null,
      description: String(description).slice(0, 500),
      unit,
      quantity_planned: m.quantity_planned,
      note: clean(m.note),
    };
  });
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const photoColumns = `
  id, folder, file_url, file_name, mime_type, size_bytes, caption, uploaded_by, created_at AS "createdAt"
`;

const staffPhotoColumns = `${photoColumns}, share_with_customer, share_with_subcontractor`;

const checklistProgress = `
  (SELECT COUNT(*)::int FROM work_order_checklist c WHERE c.work_order_id = w.id) AS checklist_total,
  (SELECT COUNT(*)::int FROM work_order_checklist c WHERE c.work_order_id = w.id AND c.is_done) AS checklist_done
`;

const assigneesJson = `COALESCE((
    SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'role', u.role) ORDER BY u.name)
    FROM work_order_assignees wa JOIN users u ON u.id = wa.user_id
    WHERE wa.work_order_id = w.id
  ), '[]'::json) AS assignees`;

const loadChildren = async (id: string) => {
  const [checklist, materials, hours, photos] = await Promise.all([
    query(
      `SELECT id, sort_order, text, is_required, is_done, done_by, done_at
       FROM work_order_checklist WHERE work_order_id = $1::uuid ORDER BY sort_order ASC, id ASC`,
      [id],
    ),
    query(
      `SELECT id, sort_order, catalogue_item_id, description, unit, quantity_planned::float8 AS quantity_planned,
              quantity_used::float8 AS quantity_used, note, added_by_crew
       FROM work_order_materials WHERE work_order_id = $1::uuid ORDER BY sort_order ASC, id ASC`,
      [id],
    ),
    query(
      `SELECT h.id, h.user_id, u.name AS user_name, to_char(h.work_date, 'YYYY-MM-DD') AS work_date, h.minutes,
              h.entry_type, h.is_billable, h.note, h.status, h.reject_reason, h.created_at AS "createdAt"
       FROM time_entries h JOIN users u ON u.id = h.user_id
       WHERE h.work_order_id = $1::uuid ORDER BY h.work_date ASC, h.created_at ASC`,
      [id],
    ),
    query(
      `SELECT ${staffPhotoColumns} FROM project_files WHERE work_order_id = $1::uuid AND mime_type <> 'application/pdf' ORDER BY created_at ASC`,
      [id],
    ),
  ]);
  return { checklist: checklist.rows, materials: materials.rows, hours: hours.rows, photos: photos.rows };
};

// Full view for the office
const getWorkOrderById = async (id: string) => {
  assertUuid(id, "work order id");

  const result = await query(
    `
      SELECT w.id, w.number, w.title, w.instructions, w.status, w.planned_date::text AS planned_date,
             w.street, w.house_number, w.postcode, w.city, w.country,
             w.work_performed, w.crew_notes, w.internal_notes,
             w.started_at, w.started_by, w.completed_at, w.completed_by, cu.name AS completed_by_name,
             w.checked_at, w.checked_by, ku.name AS checked_by_name,
             w.signed_by_name, w.signed_at, (w.signature_png IS NOT NULL) AS has_signature,
             (w.pdf_data IS NOT NULL) AS has_pdf, w.pdf_generated_at, w.sent_to_customer_at, w.sent_to,
             w.created_by, w.created_at AS "createdAt", w.updated_at AS "updatedAt",
             json_build_object('id', p.id, 'number', p.number, 'title', p.title, 'closed', p.closed_at IS NOT NULL) AS project,
             json_build_object('id', r.id, 'name', r.name, 'type', r.type, 'email', r.email, 'phone', r.phone) AS relation,
             CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object('id', a.id, 'title', a.title, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'status', a.status) END AS appointment,
             ${assigneesJson}
      FROM work_orders w
      JOIN projects p ON p.id = w.project_id
      JOIN relations r ON r.id = p.relation_id
      LEFT JOIN appointments a ON a.id = w.appointment_id
      LEFT JOIN users cu ON cu.id = w.completed_by
      LEFT JOIN users ku ON ku.id = w.checked_by
      WHERE w.id = $1::uuid
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Work order not found!");
  }
  const w = result.rows[0];
  const children = await loadChildren(id);

  const totalMinutes = children.hours.reduce((n: number, h: any) => n + h.minutes, 0);
  const billableMinutes = children.hours.filter((h: any) => h.is_billable).reduce((n: number, h: any) => n + h.minutes, 0);

  return {
    ...w,
    address: w.street
      ? { street: w.street, house_number: w.house_number, postcode: w.postcode, city: w.city, country: w.country }
      : null,
    navigation_url: navigationUrl(w),
    ...children,
    hours_summary: {
      total_minutes: totalMinutes,
      billable_minutes: billableMinutes,
      total_hours: round2(totalMinutes / 60),
      billable_hours: round2(billableMinutes / 60),
    },
    checklist_progress: {
      done: children.checklist.filter((c: any) => c.is_done).length,
      total: children.checklist.length,
    },
  };
};

// What the crew sees on their phone: instructions, address, checklist, materials, their
// own hours and photos. No internal notes, no prices, nothing of other records.
const getMyWorkOrderById = async (userId: string, id: string) => {
  assertUuid(id, "work order id");

  const result = await query(
    `
      SELECT w.id, w.number, w.title, w.instructions, w.status, w.planned_date::text AS planned_date,
             w.street, w.house_number, w.postcode, w.city, w.country,
             w.work_performed, w.crew_notes, w.started_at, w.completed_at,
             w.signed_by_name, w.signed_at, (w.signature_png IS NOT NULL) AS has_signature,
             w.updated_at AS "updatedAt",
             json_build_object('id', p.id, 'number', p.number, 'title', p.title) AS project,
             json_build_object(
               'name', r.name,
               'contact_name', COALESCE(p.contact_name, r.name),
               'contact_phone', COALESCE(p.contact_phone, r.phone)
             ) AS customer,
             CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object('id', a.id, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'all_day', a.all_day) END AS appointment,
             COALESCE((
               SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
               FROM work_order_assignees wa JOIN users u ON u.id = wa.user_id
               WHERE wa.work_order_id = w.id AND wa.user_id <> $1::uuid
             ), '[]'::json) AS colleagues
      FROM work_orders w
      JOIN work_order_assignees mine ON mine.work_order_id = w.id AND mine.user_id = $1::uuid
      JOIN projects p ON p.id = w.project_id
      JOIN relations r ON r.id = p.relation_id
      LEFT JOIN appointments a ON a.id = w.appointment_id
      WHERE w.id = $2::uuid
    `,
    [userId, id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Work order not found!");
  }
  const w = result.rows[0];

  const [checklist, materials, hours, photos] = await Promise.all([
    query(
      `SELECT id, text, is_required, is_done, done_at FROM work_order_checklist WHERE work_order_id = $1::uuid ORDER BY sort_order ASC, id ASC`,
      [id],
    ),
    query(
      `SELECT id, description, unit, quantity_planned::float8 AS quantity_planned, quantity_used::float8 AS quantity_used, note, added_by_crew
       FROM work_order_materials WHERE work_order_id = $1::uuid ORDER BY sort_order ASC, id ASC`,
      [id],
    ),
    query(
      `SELECT id, to_char(work_date, 'YYYY-MM-DD') AS work_date, minutes, entry_type, is_billable, note, status, reject_reason
       FROM time_entries WHERE work_order_id = $1::uuid AND user_id = $2::uuid ORDER BY work_date ASC, created_at ASC`,
      [id, userId],
    ),
    query(
      `SELECT id, file_url, file_name, mime_type, caption, created_at AS "createdAt"
       FROM project_files WHERE work_order_id = $1::uuid AND mime_type <> 'application/pdf' ORDER BY created_at ASC`,
      [id],
    ),
  ]);

  return {
    id: w.id,
    number: w.number,
    title: w.title,
    instructions: w.instructions,
    status: w.status,
    planned_date: w.planned_date,
    address: w.street
      ? { street: w.street, house_number: w.house_number, postcode: w.postcode, city: w.city, country: w.country }
      : null,
    navigation_url: navigationUrl(w),
    project: w.project,
    customer: w.customer,
    appointment: w.appointment,
    colleagues: w.colleagues,
    checklist: checklist.rows,
    materials: materials.rows,
    hours: hours.rows,
    photos: photos.rows,
    work_performed: w.work_performed,
    notes: w.crew_notes,
    started_at: w.started_at,
    completed_at: w.completed_at,
    signature: w.has_signature ? { signed_by_name: w.signed_by_name, signed_at: w.signed_at } : null,
    updated_at: w.updatedAt,
  };
};

// Whatever the caller is allowed to see after a change
const viewFor = (actor: IActor, id: string) =>
  isStaff(actor) ? getWorkOrderById(id) : getMyWorkOrderById(actor.id, id);

const getAllWorkOrders = async (params: Record<string, any>, actorId: string) => {
  const { page, limit, skip, sortBy, sortOrder } = paginationHelper.calculatePagination(params as any);

  const sortable: Record<string, string> = {
    created_at: "w.created_at",
    number: "w.number",
    title: "LOWER(w.title)",
    planned_date: "w.planned_date",
    status: "w.status",
    completed_at: "w.completed_at",
  };
  const orderColumn = sortable[sortBy] ?? "w.created_at";
  const orderDirection = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  const conditions: string[] = [];
  const values: any[] = [];
  let n = 1;

  if (params.searchTerm) {
    const term = String(Array.isArray(params.searchTerm) ? params.searchTerm[0] : params.searchTerm)
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(
      `(w.number ILIKE $${n} OR w.title ILIKE $${n} OR p.title ILIKE $${n} OR p.number ILIKE $${n} OR r.name ILIKE $${n} OR w.city ILIKE $${n})`,
    );
    values.push(`%${term}%`);
    n++;
  }

  if (params.status) {
    const statuses = asList(params.status).map((s) => s.toUpperCase());
    if (statuses.some((s) => !(workOrderStatuses as readonly string[]).includes(s))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Status should be OPEN, IN_PROGRESS, COMPLETED or CHECKED!");
    }
    conditions.push(`w.status = ANY($${n++}::text[])`);
    values.push(statuses);
  }

  if (params.project_id) {
    assertUuid(String(params.project_id), "project id");
    conditions.push(`w.project_id = $${n++}::uuid`);
    values.push(String(params.project_id));
  }

  if (params.appointment_id) {
    assertUuid(String(params.appointment_id), "appointment id");
    conditions.push(`w.appointment_id = $${n++}::uuid`);
    values.push(String(params.appointment_id));
  }

  if (params.assignee) {
    const who = String(params.assignee);
    if (who === "none") {
      conditions.push(`NOT EXISTS (SELECT 1 FROM work_order_assignees x WHERE x.work_order_id = w.id)`);
    } else {
      const id = who === "me" ? actorId : who;
      assertUuid(id, "user id");
      conditions.push(`EXISTS (SELECT 1 FROM work_order_assignees x WHERE x.work_order_id = w.id AND x.user_id = $${n++}::uuid)`);
      values.push(id);
    }
  }

  // Finished by the crew and waiting for the office's check
  if (String(params.to_check) === "true") {
    conditions.push(`w.status = 'COMPLETED'`);
  }

  for (const [param, column, operator] of [
    ["planned_from", "w.planned_date", ">="],
    ["planned_to", "w.planned_date", "<="],
    ["created_from", "(w.created_at AT TIME ZONE 'Europe/Amsterdam')::date", ">="],
    ["created_to", "(w.created_at AT TIME ZONE 'Europe/Amsterdam')::date", "<="],
  ] as const) {
    if (params[param]) {
      const day = String(params[param]);
      if (!isValidDay(day)) {
        throw new ApiError(httpStatus.BAD_REQUEST, `${param} must be a date like 2026-11-30!`);
      }
      conditions.push(`${column} ${operator} $${n++}::date`);
      values.push(day);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `
    FROM work_orders w
    JOIN projects p ON p.id = w.project_id
    JOIN relations r ON r.id = p.relation_id
  `;

  const [result, count] = await Promise.all([
    query(
      `
        SELECT w.id, w.number, w.title, w.status, w.planned_date::text AS planned_date, w.city,
               w.completed_at, w.checked_at, w.created_at AS "createdAt",
               json_build_object('id', p.id, 'number', p.number, 'title', p.title) AS project,
               json_build_object('id', r.id, 'name', r.name) AS relation,
               ${checklistProgress},
               COALESCE((SELECT SUM(h.minutes) FROM time_entries h WHERE h.work_order_id = w.id), 0)::int AS hours_minutes,
               (w.signature_png IS NOT NULL) AS has_signature,
               ${assigneesJson}
        ${from}
        ${where}
        ORDER BY ${orderColumn} ${orderDirection} NULLS LAST, w.id ASC
        LIMIT $${n} OFFSET $${n + 1}
      `,
      [...values, limit, skip],
    ),
    query(`SELECT COUNT(*) AS total ${from} ${where}`, values),
  ]);

  const total = parseInt(count.rows[0].total);
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

// The crew's list: only theirs. Finished ones are hidden unless asked for.
const getMyWorkOrders = async (userId: string, params: Record<string, any>) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);

  const conditions = [`mine.user_id = $1::uuid`];
  const values: any[] = [userId];
  let n = 2;

  if (String(params.include_done) !== "true") {
    conditions.push(`w.status IN ('OPEN', 'IN_PROGRESS')`);
  }
  for (const [param, operator] of [["from", ">="], ["to", "<="]] as const) {
    if (params[param]) {
      const day = String(params[param]);
      if (!isValidDay(day)) {
        throw new ApiError(httpStatus.BAD_REQUEST, `${param} must be a date like 2026-11-30!`);
      }
      conditions.push(`w.planned_date ${operator} $${n++}::date`);
      values.push(day);
    }
  }

  const from = `
    FROM work_orders w
    JOIN work_order_assignees mine ON mine.work_order_id = w.id
    JOIN projects p ON p.id = w.project_id
    JOIN relations r ON r.id = p.relation_id
    WHERE ${conditions.join(" AND ")}
  `;

  const [result, count] = await Promise.all([
    query(
      `
        SELECT w.id, w.number, w.title, w.status, w.planned_date::text AS planned_date,
               w.street, w.house_number, w.postcode, w.city, w.country,
               json_build_object('number', p.number, 'title', p.title) AS project,
               r.name AS customer_name,
               ${checklistProgress}
        ${from}
        ORDER BY w.planned_date ASC NULLS LAST, w.created_at ASC
        LIMIT $${n} OFFSET $${n + 1}
      `,
      [...values, limit, skip],
    ),
    query(`SELECT COUNT(*) AS total ${from}`, values),
  ]);

  const total = parseInt(count.rows[0].total);
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows.map((w: any) => ({
      id: w.id,
      number: w.number,
      title: w.title,
      status: w.status,
      planned_date: w.planned_date,
      address: w.street
        ? { street: w.street, house_number: w.house_number, postcode: w.postcode, city: w.city, country: w.country }
        : null,
      navigation_url: navigationUrl(w),
      project: w.project,
      customer_name: w.customer_name,
      checklist_total: w.checklist_total,
      checklist_done: w.checklist_done,
    })),
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

// ---------------------------------------------------------------------------
// Create / edit / delete (FR-WO-01)
// ---------------------------------------------------------------------------

const insertChecklist = async (client: any, workOrderId: string, items: IChecklistItemInput[]) => {
  for (const [i, item] of items.entries()) {
    await client.query(
      `INSERT INTO work_order_checklist (work_order_id, sort_order, text, is_required) VALUES ($1::uuid, $2, $3, $4)`,
      [workOrderId, i, item.text.trim(), item.is_required !== false],
    );
  }
};

const insertMaterials = async (client: any, workOrderId: string, items: Awaited<ReturnType<typeof prepareMaterials>>) => {
  for (const [i, m] of items.entries()) {
    await client.query(
      `INSERT INTO work_order_materials (work_order_id, sort_order, catalogue_item_id, description, unit, quantity_planned, note)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)`,
      [workOrderId, i, m.catalogue_item_id, m.description, m.unit, m.quantity_planned, m.note],
    );
  }
};

// From a project, optionally from one of its planned appointments (then the crew,
// date and address follow the appointment unless given).
// Crew on a work order are in its project's chat: their chat list updates live
const announceWorkOrderProject = async (workOrderId: string) =>
  announceProject((await query(`SELECT project_id FROM work_orders WHERE id = $1::uuid`, [workOrderId])).rows[0]?.project_id, { includeCrewLoss: true });

// Tells the people put on a work order that it is theirs (which job, which project, when, where).
// Called AFTER the work order is saved; whoever issued it is never told about their own action, and it
// never throws. The crew's phone view has no prices and no internal notes, and neither does this.
const notifyAssigned = async (workOrder: any, userIds: string[], actorId: string | null) => {
  try {
    if (userIds.length === 0) return;
    const where = [workOrder.street, workOrder.house_number, workOrder.postcode, workOrder.city]
      .filter(Boolean)
      .join(" ");
    await notify(userIds, {
      type: "WORK_ORDER_ASSIGNED",
      title: `Work order ${workOrder.number} issued for you: ${workOrder.title}`,
      body: [
        workOrder.project ? `Project ${workOrder.project.number} ${workOrder.project.title}` : null,
        workOrder.planned_date ? formatDate(workOrder.planned_date, "EN") : null,
        where,
      ]
        .filter(Boolean)
        .join(" · "),
      entity: { type: "work_order", id: workOrder.id },
      actorId,
    });
  } catch (error: any) {
    console.error("❌ Work order notification failed:", error?.message ?? error);
  }
};

// Tells the people already on a work order that its date or address changed (what it was, what it is
// now). Called AFTER the change is saved; whoever changed it is never told, and it never throws.
const notifyChanged = async (
  workOrder: any,
  userIds: string[],
  before: { planned_date: string | null; address: string },
  actorId: string | null,
) => {
  try {
    if (userIds.length === 0) return;
    const nowAddress = addressLines(workOrder).join(", ");
    const lines: string[] = [];
    const nowDate = workOrder.planned_date ?? null;
    if (nowDate !== before.planned_date) {
      const show = (d: string | null) => (d ? formatDate(d, "EN") : "no date");
      lines.push(`Date: ${show(nowDate)} (was ${show(before.planned_date)})`);
    }
    if (nowAddress !== before.address) {
      lines.push(`Address: ${nowAddress || "none"} (was ${before.address || "none"})`);
    }
    if (lines.length === 0) return;
    await notify(userIds, {
      type: "WORK_ORDER_CHANGED",
      title: `Work order ${workOrder.number} changed: ${workOrder.title}`,
      body: [workOrder.project ? `Project ${workOrder.project.number}` : null, ...lines].filter(Boolean).join(" · "),
      entity: { type: "work_order", id: workOrder.id },
      actorId,
    });
  } catch (error: any) {
    console.error("❌ Work order change notification failed:", error?.message ?? error);
  }
};

const createWorkOrder = async (input: ICreateWorkOrder, actorId: string) => {
  assertUuid(input.project_id, "project id");
  const project = await projectContext({ query: query } as any, input.project_id);
  if (!project) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }
  if (project.closed_at) {
    throw new ApiError(httpStatus.CONFLICT, "This project is closed. Reopen it before issuing work orders!");
  }

  let appointment: any = null;
  if (input.appointment_id) {
    assertUuid(input.appointment_id, "appointment id");
    const found = await query(
      `
        SELECT a.id, a.title, a.status, a.project_id, a.street, a.house_number, a.postcode, a.city, a.country,
               (a.starts_at AT TIME ZONE 'Europe/Amsterdam')::date::text AS day,
               COALESCE((SELECT array_agg(aa.user_id) FROM appointment_assignees aa
                         JOIN users u ON u.id = aa.user_id
                         WHERE aa.appointment_id = a.id AND u.is_active AND u.status = 'ACTIVE'
                           AND u.role::text = ANY($2::text[])), '{}') AS assignee_ids
        FROM appointments a WHERE a.id = $1::uuid
      `,
      [input.appointment_id, assignableRoles],
    );
    if (found.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Appointment not found!");
    }
    appointment = found.rows[0];
    if (appointment.project_id !== project.id) {
      throw new ApiError(httpStatus.BAD_REQUEST, "This appointment does not belong to the project!");
    }
    if (appointment.status === "CANCELLED") {
      throw new ApiError(httpStatus.BAD_REQUEST, "This appointment is cancelled!");
    }
  }

  const assigneeIds =
    input.assignee_ids !== undefined
      ? await assertAssignees(input.assignee_ids)
      : ((appointment?.assignee_ids ?? []) as string[]);

  const address =
    input.address !== undefined
      ? input.address
        ? normalizeAddress(input.address)
        : null
      : appointment?.street
        ? normalizeAddress(appointment)
        : project.street
          ? normalizeAddress(project)
          : null;

  const title = clean(input.title) ?? appointment?.title ?? `Werkbon - ${project.title}`;
  const plannedDate = input.planned_date !== undefined ? input.planned_date : (appointment?.day ?? null);
  const materials = input.materials ? await prepareMaterials(input.materials) : [];

  const id = await transaction(async (client) => {
    const number = await SettingsService.nextDocumentNumber("work_order", client);

    const created = await client.query(
      `
        INSERT INTO work_orders (
          number, project_id, appointment_id, title, instructions, planned_date,
          street, house_number, postcode, city, country, internal_notes, created_by
        ) VALUES (
          $1, $2::uuid, $3::uuid, $4, $5, $6::date,
          $7, $8, $9, $10, COALESCE($11, 'NL'), $12, $13::uuid
        ) RETURNING id
      `,
      [
        number,
        project.id,
        appointment?.id ?? null,
        String(title).slice(0, 255),
        clean(input.instructions),
        plannedDate,
        address?.street ?? null,
        address?.house_number ?? null,
        address?.postcode ?? null,
        address?.city ?? null,
        address?.country ?? null,
        clean(input.internal_notes),
        actorId,
      ],
    );
    const workOrderId = created.rows[0].id as string;

    await replaceAssignees(client, workOrderId, assigneeIds);
    if (input.checklist?.length) await insertChecklist(client, workOrderId, input.checklist);
    if (materials.length) await insertMaterials(client, workOrderId, materials);

    await logWorkOrderEvent(
      client,
      { id: workOrderId },
      project.relation_id,
      "WORK_ORDER_CREATED",
      `Work order ${number} issued for project ${project.number}`,
      actorId,
      { metadata: { project_id: project.id, appointment_id: appointment?.id ?? null } },
    );
    await logAudit(
      { actor_id: actorId, action: "CREATE", entity_type: "work_order", entity_id: workOrderId, changes: { number, project_id: project.id } },
      client,
    );
    return workOrderId;
  });

  await announceWorkOrderProject(id);
  const created = await getWorkOrderById(id);
  // Everyone put on it is told
  await notifyAssigned(created, assigneeIds, actorId);
  return created;
};

const updateWorkOrder = async (id: string, payload: IUpdateWorkOrder, actorId: string) => {
  const assigneeIds = payload.assignee_ids !== undefined ? await assertAssignees(payload.assignee_ids) : undefined;
  // Who was on it before this change (to tell only the people who are new)
  let assigneesBefore: string[] = [];
  // Date and address before this change, to tell the crew only when one of them really changed
  let planBefore: { planned_date: string | null; address: string } | null = null;

  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    const plan = (
      await client.query(
        `SELECT planned_date::text AS planned_date, street, house_number, postcode, city FROM work_orders WHERE id = $1::uuid`,
        [id],
      )
    ).rows[0];
    planBefore = { planned_date: plan.planned_date ?? null, address: addressLines(plan).join(", ") };
    assigneesBefore = (
      await client.query(`SELECT user_id FROM work_order_assignees WHERE work_order_id = $1::uuid`, [id])
    ).rows.map((r: any) => r.user_id as string);

    // Once completed only the office's own note can still change
    const finished = workOrder.status === "COMPLETED" || workOrder.status === "CHECKED";
    const onlyNote = Object.keys(payload).every((k) => k === "internal_notes");
    if (finished && !onlyNote) {
      throw new ApiError(httpStatus.CONFLICT, "This work order is already completed. Reopen it to change it!");
    }

    const data: Record<string, any> = {};
    if (payload.title !== undefined) {
      data.title = clean(payload.title);
      if (!data.title) throw new ApiError(httpStatus.BAD_REQUEST, "A work order needs a title!");
    }
    if (payload.instructions !== undefined) data.instructions = clean(payload.instructions);
    if (payload.planned_date !== undefined) data.planned_date = payload.planned_date;
    if (payload.internal_notes !== undefined) data.internal_notes = clean(payload.internal_notes);
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

    if (Object.keys(data).length > 0) {
      const casts: Record<string, string> = { planned_date: "::date" };
      const updates: string[] = [];
      const values: any[] = [];
      let n = 1;
      for (const [field, value] of Object.entries(data)) {
        updates.push(`${field} = $${n++}${casts[field] ?? ""}`);
        values.push(value);
      }
      updates.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);
      await client.query(`UPDATE work_orders SET ${updates.join(", ")} WHERE id = $${n}::uuid`, values);
    } else {
      await client.query(`UPDATE work_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
    }
    if (assigneeIds !== undefined) await replaceAssignees(client, id, assigneeIds);

    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "work_order",
        entity_id: id,
        changes: { fields: [...Object.keys(data), ...(assigneeIds !== undefined ? ["assignee_ids"] : [])] },
      },
      client,
    );
  });

  if (assigneeIds !== undefined) await announceWorkOrderProject(id);
  const updated = await getWorkOrderById(id);
  // People added by this change are told it is theirs; those who stay or were taken off are not
  if (assigneeIds !== undefined) {
    await notifyAssigned(
      updated,
      assigneeIds.filter((userId) => !assigneesBefore.includes(userId)),
      actorId,
    );
  }
  // People who were already on it and still are hear that the date or address changed
  if (planBefore) {
    const stay = (assigneeIds ?? assigneesBefore).filter((userId) => assigneesBefore.includes(userId));
    await notifyChanged(updated, stay, planBefore, actorId);
  }
  return updated;
};

// Only one that nobody has started working on
const deleteWorkOrder = async (id: string, actorId: string) => {
  let projectId: string | null = null;
  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    if (workOrder.status !== "OPEN") {
      throw new ApiError(httpStatus.CONFLICT, "Only a work order that has not been started can be deleted!");
    }

    const used = await client.query(
      `
        SELECT
          (SELECT COUNT(*)::int FROM time_entries WHERE work_order_id = $1::uuid) AS hours,
          (SELECT COUNT(*)::int FROM project_files WHERE work_order_id = $1::uuid) AS files,
          (SELECT COUNT(*)::int FROM work_order_checklist WHERE work_order_id = $1::uuid AND is_done) AS done_items,
          (SELECT COUNT(*)::int FROM work_order_materials WHERE work_order_id = $1::uuid AND quantity_used IS NOT NULL) AS used_materials,
          (SELECT (COALESCE(work_performed, '') <> '' OR COALESCE(crew_notes, '') <> '')::int FROM work_orders WHERE id = $1::uuid) AS has_text
      `,
      [id],
    );
    const u = used.rows[0];
    if (u.hours > 0 || u.files > 0 || u.done_items > 0 || u.used_materials > 0 || u.has_text > 0) {
      throw new ApiError(httpStatus.CONFLICT, "Work has already been recorded on this work order, so it cannot be deleted!");
    }

    projectId = workOrder.project_id ?? null;
    const project = await projectContext(client, workOrder.project_id);
    await client.query(`DELETE FROM work_orders WHERE id = $1::uuid`, [id]);
    await logWorkOrderEvent(client, { id }, project.relation_id, "WORK_ORDER_DELETED", `Work order ${workOrder.number} deleted`, actorId);
    await logAudit(
      { actor_id: actorId, action: "DELETE", entity_type: "work_order", entity_id: id, changes: { number: workOrder.number } },
      client,
    );
  });
  await announceProject(projectId, { includeCrewLoss: true });
};

// The office's checklist: keep items (and their done state) by id, add new ones, drop the rest
const setChecklist = async (id: string, items: IChecklistItemInput[], actorId: string) => {
  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    assertEditable(workOrder);

    const existing = await client.query(`SELECT id FROM work_order_checklist WHERE work_order_id = $1::uuid`, [id]);
    const known = new Set(existing.rows.map((r: any) => r.id));
    const keep = items.filter((i) => i.id).map((i) => i.id as string);
    if (keep.some((k) => !known.has(k))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "A checklist item does not belong to this work order!");
    }
    if (new Set(keep).size !== keep.length) {
      throw new ApiError(httpStatus.BAD_REQUEST, "A checklist item appears twice!");
    }

    await client.query(`DELETE FROM work_order_checklist WHERE work_order_id = $1::uuid AND NOT (id = ANY($2::uuid[]))`, [id, keep]);
    for (const [i, item] of items.entries()) {
      if (item.id) {
        await client.query(
          `UPDATE work_order_checklist SET text = $2, is_required = $3, sort_order = $4 WHERE id = $1::uuid`,
          [item.id, item.text.trim(), item.is_required !== false, i],
        );
      } else {
        await client.query(
          `INSERT INTO work_order_checklist (work_order_id, sort_order, text, is_required) VALUES ($1::uuid, $2, $3, $4)`,
          [id, i, item.text.trim(), item.is_required !== false],
        );
      }
    }
    await client.query(`UPDATE work_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
    await logAudit(
      { actor_id: actorId, action: "UPDATE", entity_type: "work_order", entity_id: id, changes: { checklist_items: items.length } },
      client,
    );
  });

  return getWorkOrderById(id);
};

const setMaterials = async (id: string, items: IMaterialInput[], actorId: string) => {
  const prepared = await prepareMaterials(items);

  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    assertEditable(workOrder);

    const existing = await client.query(`SELECT id FROM work_order_materials WHERE work_order_id = $1::uuid`, [id]);
    const known = new Set(existing.rows.map((r: any) => r.id));
    const keep = prepared.filter((m) => m.id).map((m) => m.id as string);
    if (keep.some((k) => !known.has(k))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "A material does not belong to this work order!");
    }
    if (new Set(keep).size !== keep.length) {
      throw new ApiError(httpStatus.BAD_REQUEST, "A material appears twice!");
    }

    await client.query(`DELETE FROM work_order_materials WHERE work_order_id = $1::uuid AND NOT (id = ANY($2::uuid[]))`, [id, keep]);
    for (const [i, m] of prepared.entries()) {
      if (m.id) {
        await client.query(
          `UPDATE work_order_materials
           SET catalogue_item_id = $2::uuid, description = $3, unit = $4, quantity_planned = $5, note = $6, sort_order = $7
           WHERE id = $1::uuid`,
          [m.id, m.catalogue_item_id, m.description, m.unit, m.quantity_planned, m.note, i],
        );
      } else {
        await client.query(
          `INSERT INTO work_order_materials (work_order_id, sort_order, catalogue_item_id, description, unit, quantity_planned, note)
           VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)`,
          [id, i, m.catalogue_item_id, m.description, m.unit, m.quantity_planned, m.note],
        );
      }
    }
    await client.query(`UPDATE work_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
    await logAudit(
      { actor_id: actorId, action: "UPDATE", entity_type: "work_order", entity_id: id, changes: { materials: items.length } },
      client,
    );
  });

  return getWorkOrderById(id);
};

// ---------------------------------------------------------------------------
// Working on it (FR-WO-02, FR-WO-06, FR-WO-07)
// ---------------------------------------------------------------------------

// Marks the work order as started (first time only) and moves a "new" project on
const markStarted = async (client: any, workOrder: any, actorId: string) => {
  if (workOrder.status !== "OPEN") return false;

  await client.query(
    `UPDATE work_orders SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP, started_by = $2::uuid, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
    [workOrder.id, actorId],
  );
  const project = await projectContext(client, workOrder.project_id);
  await logWorkOrderEvent(client, workOrder, project.relation_id, "WORK_ORDER_STARTED", `Work order ${workOrder.number} started`, actorId);
  await ProjectService.moveToInProgressFromWorkOrder(client, workOrder.project_id, actorId);
  workOrder.status = "IN_PROGRESS";
  return true;
};

// Starting twice is fine (a phone that retries after a dropped connection)
const startWorkOrder = async (id: string, actor: IActor) => {
  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    await assertAccess(client, id, actor);

    if (workOrder.status === "COMPLETED" || workOrder.status === "CHECKED") {
      throw new ApiError(httpStatus.CONFLICT, "This work order is already completed!");
    }
    await markStarted(client, workOrder, actor.id);
  });

  return viewFor(actor, id);
};

const parseDoneAt = (value: string | undefined) => {
  if (!value) return new Date();
  const d = new Date(value);
  // A phone clock that runs ahead must not stamp the future
  return d.getTime() > Date.now() ? new Date() : d;
};

const assertHourDate = (day: string) => {
  if (day > amsterdamToday()) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Hours cannot be registered for a future date!");
  }
};

const insertHour = async (client: any, workOrder: { id: string; project_id: string }, userId: string, hour: IHourInput, createdBy: string) => {
  assertHourDate(hour.work_date);
  // A retried upload (same client_id) is skipped, so it is not counted twice either
  if (hour.client_id) {
    const seen = await client.query(`SELECT 1 FROM time_entries WHERE user_id = $1::uuid AND client_id = $2::uuid`, [userId, hour.client_id]);
    if (seen.rows.length > 0) return false;
  }
  await assertDailyLimit(client, userId, hour.work_date, hour.minutes);
  const result = await client.query(
    `
      INSERT INTO time_entries (project_id, work_order_id, user_id, work_date, minutes, entry_type, is_billable, note, client_id, created_by)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8, $9::uuid, $10::uuid)
      ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
      RETURNING id
    `,
    [
      workOrder.project_id,
      workOrder.id,
      userId,
      hour.work_date,
      hour.minutes,
      hour.entry_type ?? "WORK",
      hour.is_billable !== false,
      clean(hour.note),
      hour.client_id ?? null,
      createdBy,
    ],
  );
  return result.rows.length > 0;
};

// Everything a phone collected while offline, in one call. Safe to send again: checklist
// ticks and quantities just set the same values, and crew-added materials and hours carry
// a client_id, so a retry never doubles them. Last write wins on the text fields.
const syncWorkOrder = async (id: string, payload: ISyncWorkOrder, actor: IActor) => {
  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    await assertAccess(client, id, actor);

    if (workOrder.status === "COMPLETED" || workOrder.status === "CHECKED") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "This work order was completed in the meantime, so these changes could not be saved. Ask the office to reopen it!",
      );
    }

    // Filling it in counts as starting it
    await markStarted(client, workOrder, actor.id);

    if (payload.work_performed !== undefined) {
      await client.query(`UPDATE work_orders SET work_performed = $2 WHERE id = $1::uuid`, [id, clean(payload.work_performed)]);
    }
    if (payload.notes !== undefined) {
      await client.query(`UPDATE work_orders SET crew_notes = $2 WHERE id = $1::uuid`, [id, clean(payload.notes)]);
    }

    if (payload.checklist?.length) {
      const ids = payload.checklist.map((c) => c.id);
      const own = await client.query(
        `SELECT id FROM work_order_checklist WHERE work_order_id = $1::uuid AND id = ANY($2::uuid[])`,
        [id, ids],
      );
      if (own.rows.length !== new Set(ids).size) {
        throw new ApiError(httpStatus.BAD_REQUEST, "A checklist item does not belong to this work order!");
      }
      for (const item of payload.checklist) {
        await client.query(
          `UPDATE work_order_checklist
           SET is_done = $2, done_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END, done_at = CASE WHEN $2 THEN $4::timestamptz ELSE NULL END
           WHERE id = $1::uuid`,
          [item.id, item.is_done, actor.id, parseDoneAt(item.done_at).toISOString()],
        );
      }
    }

    if (payload.materials?.length) {
      const ids = payload.materials.map((m) => m.id);
      const own = await client.query(
        `SELECT id FROM work_order_materials WHERE work_order_id = $1::uuid AND id = ANY($2::uuid[])`,
        [id, ids],
      );
      if (own.rows.length !== new Set(ids).size) {
        throw new ApiError(httpStatus.BAD_REQUEST, "A material does not belong to this work order!");
      }
      for (const m of payload.materials) {
        await client.query(`UPDATE work_order_materials SET quantity_used = $2 WHERE id = $1::uuid`, [m.id, m.quantity_used]);
      }
    }

    if (payload.extra_materials?.length) {
      const next = await client.query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM work_order_materials WHERE work_order_id = $1::uuid`,
        [id],
      );
      let order = Number(next.rows[0].next);
      for (const m of payload.extra_materials) {
        const added = await client.query(
          `
            INSERT INTO work_order_materials (work_order_id, sort_order, description, unit, quantity_planned, quantity_used, note, added_by_crew, client_id)
            VALUES ($1::uuid, $2, $3, $4, 0, $5, $6, true, $7::uuid)
            ON CONFLICT (work_order_id, client_id) DO NOTHING
            RETURNING id
          `,
          [id, order, m.description.trim(), m.unit, m.quantity_used, clean(m.note), m.client_id],
        );
        if (added.rows.length > 0) order++;
      }
    }

    for (const hour of payload.hours ?? []) {
      await insertHour(client, workOrder, actor.id, hour, actor.id);
    }

    await client.query(`UPDATE work_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
  });

  return viewFor(actor, id);
};

// ---------------------------------------------------------------------------
// Hours (FR-WO-05)
// ---------------------------------------------------------------------------

const hourPermission = (workOrder: { status: string }, actor: IActor, ownerId: string, hourStatus: string | null = null) => {
  if (hourStatus === "APPROVED") {
    throw new ApiError(httpStatus.CONFLICT, "This hour entry has been approved. Ask the office to unapprove it first!");
  }
  if (workOrder.status === "CHECKED") {
    throw new ApiError(httpStatus.CONFLICT, "This work order has been checked. Reopen it to change hours!");
  }
  if (!isStaff(actor)) {
    if (ownerId !== actor.id) {
      throw new ApiError(httpStatus.FORBIDDEN, "You can only change your own hours!");
    }
    if (workOrder.status === "COMPLETED") {
      throw new ApiError(httpStatus.CONFLICT, "This work order is completed. Ask the office to correct hours!");
    }
  }
};

const addHours = async (id: string, input: IHourInput, actor: IActor) => {
  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    await assertAccess(client, id, actor);

    let userId = actor.id;
    if (input.user_id && input.user_id !== actor.id) {
      if (!isStaff(actor)) {
        throw new ApiError(httpStatus.FORBIDDEN, "You can only register your own hours!");
      }
      const [user] = await assertAssignees([input.user_id]);
      userId = user;
    }
    hourPermission(workOrder, actor, userId);

    await markStarted(client, workOrder, actor.id);
    await insertHour(client, workOrder, userId, input, actor.id);
    await client.query(`UPDATE work_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
  });

  return viewFor(actor, id);
};

const loadHour = async (client: any, workOrderId: string, hourId: string) => {
  assertUuid(hourId, "hour id");
  const found = await client.query(
    `SELECT id, user_id, status, to_char(work_date, 'YYYY-MM-DD') AS work_date, minutes
     FROM time_entries WHERE id = $1::uuid AND work_order_id = $2::uuid FOR UPDATE`,
    [hourId, workOrderId],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Hour entry not found!");
  }
  return found.rows[0];
};

const updateHours = async (id: string, hourId: string, payload: Partial<IHourInput>, actor: IActor) => {
  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    await assertAccess(client, id, actor);
    const hour = await loadHour(client, id, hourId);
    hourPermission(workOrder, actor, hour.user_id, hour.status);

    if (payload.work_date !== undefined) assertHourDate(payload.work_date);
    await assertDailyLimit(client, hour.user_id, payload.work_date ?? hour.work_date, payload.minutes ?? hour.minutes, hourId);
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
    if (updates.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
    }
    // Correcting a rejected entry sends it back for review
    updates.push(`status = CASE WHEN status = 'REJECTED' THEN 'SUBMITTED' ELSE status END`);
    updates.push(`reject_reason = CASE WHEN status = 'REJECTED' THEN NULL ELSE reject_reason END`);
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(hourId);
    await client.query(`UPDATE time_entries SET ${updates.join(", ")} WHERE id = $${n}::uuid`, values);
    await client.query(`UPDATE work_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
    if (isStaff(actor)) {
      await logAudit(
        { actor_id: actor.id, action: "UPDATE", entity_type: "time_entry", entity_id: hourId, changes: { work_order_id: id, fields: Object.keys(data) } },
        client,
      );
    }
  });

  return viewFor(actor, id);
};

const deleteHours = async (id: string, hourId: string, actor: IActor) => {
  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    await assertAccess(client, id, actor);
    const hour = await loadHour(client, id, hourId);
    hourPermission(workOrder, actor, hour.user_id, hour.status);

    await client.query(`DELETE FROM time_entries WHERE id = $1::uuid`, [hourId]);
    await client.query(`UPDATE work_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
    if (isStaff(actor)) {
      await logAudit(
        { actor_id: actor.id, action: "DELETE", entity_type: "time_entry", entity_id: hourId, changes: { work_order_id: id } },
        client,
      );
    }
  });

  return viewFor(actor, id);
};

// ---------------------------------------------------------------------------
// Photos (FR-WO-02): they are kept in the project's documents
// ---------------------------------------------------------------------------

const addPhotos = async (id: string, files: any[], fields: Record<string, any>, actor: IActor) => {
  assertUuid(id, "work order id");
  const found = await query(`SELECT id, project_id, status FROM work_orders WHERE id = $1::uuid`, [id]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Work order not found!");
  }
  const workOrder = found.rows[0];
  await assertAccess({ query } as any, id, actor);

  if (workOrder.status === "CHECKED" || (!isStaff(actor) && workOrder.status === "COMPLETED")) {
    throw new ApiError(httpStatus.CONFLICT, "This work order is completed. Photos can no longer be added!");
  }
  const count = await query(
    `SELECT COUNT(*)::int AS n FROM project_files WHERE work_order_id = $1::uuid AND mime_type <> 'application/pdf'`,
    [id],
  );
  if (count.rows[0].n + (files?.length ?? 0) > MAX_PHOTOS_PER_WORK_ORDER) {
    throw new ApiError(httpStatus.BAD_REQUEST, `A work order can have at most ${MAX_PHOTOS_PER_WORK_ORDER} photos!`);
  }

  // The crew cannot decide what customers or subcontractors see in their portals
  const safeFields = isStaff(actor)
    ? fields
    : { folder: fields.folder, caption: fields.caption, share_with_customer: false, share_with_subcontractor: false };

  const saved = await ProjectService.addFiles(workOrder.project_id, files, safeFields, actor.id, {
    workOrderId: id,
    defaultFolder: "DURING",
  });

  // A first photo counts as starting the work
  await transaction(async (client) => {
    const locked = await lockWorkOrder(client, id);
    await markStarted(client, locked, actor.id);
    await client.query(`UPDATE work_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
  }).catch(() => undefined);

  return saved.map((f: any) => ({
    id: f.id,
    folder: f.folder,
    file_url: f.file_url,
    file_name: f.file_name,
    mime_type: f.mime_type,
    caption: f.caption,
    createdAt: f.createdAt,
  }));
};

const deletePhoto = async (id: string, fileId: string, actor: IActor) => {
  assertUuid(id, "work order id");
  assertUuid(fileId, "file id");

  const found = await query(
    `
      SELECT f.id, f.project_id, f.uploaded_by, w.status
      FROM project_files f JOIN work_orders w ON w.id = f.work_order_id
      WHERE f.id = $1::uuid AND f.work_order_id = $2::uuid AND f.mime_type <> 'application/pdf'
    `,
    [fileId, id],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Photo not found!");
  }
  const photo = found.rows[0];
  await assertAccess({ query } as any, id, actor);

  if (!isStaff(actor)) {
    if (photo.uploaded_by !== actor.id) {
      throw new ApiError(httpStatus.FORBIDDEN, "You can only delete your own photos!");
    }
    if (photo.status === "COMPLETED" || photo.status === "CHECKED") {
      throw new ApiError(httpStatus.CONFLICT, "This work order is completed. Photos can no longer be removed!");
    }
  }

  await ProjectService.deleteFile(photo.project_id, fileId, actor.id);
};

// ---------------------------------------------------------------------------
// Signature (FR-WO-03)
// ---------------------------------------------------------------------------

// Accepts "data:image/png;base64,..." and checks the bytes really are a PNG
const parseSignature = (dataUrl: string) => {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!match) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The signature must be a PNG image (data:image/png;base64,...)!");
  }
  const buffer = Buffer.from(match[1].replace(/\s/g, ""), "base64");
  if (buffer.length < 100 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The signature is not a valid PNG image!");
  }
  if (buffer.length > MAX_SIGNATURE_BYTES) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The signature image is too large (max 300 KB)!");
  }
  return buffer;
};

const saveSignature = async (client: any, workOrderId: string, name: string, png: Buffer) => {
  await client.query(
    `UPDATE work_orders SET signed_by_name = $2, signed_at = CURRENT_TIMESTAMP, signature_png = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
    [workOrderId, name.trim(), png],
  );
};

const setSignature = async (id: string, payload: ISignatureInput, actor: IActor) => {
  const png = parseSignature(payload.signature);

  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    await assertAccess(client, id, actor);
    assertEditable(workOrder, "signed");

    await markStarted(client, workOrder, actor.id);
    await saveSignature(client, id, payload.signed_by_name, png);
  });

  return viewFor(actor, id);
};

// ---------------------------------------------------------------------------
// Completing, checking, reopening (FR-WO-06)
// ---------------------------------------------------------------------------

const completeWorkOrder = async (id: string, payload: ICompleteWorkOrder, actor: IActor) => {
  const png = payload.signature ? parseSignature(payload.signature) : null;

  const done = await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    await assertAccess(client, id, actor);

    // Completing twice is fine (a phone that retries): nothing happens the second time
    if (workOrder.status === "COMPLETED" || workOrder.status === "CHECKED") return false;

    await markStarted(client, workOrder, actor.id);

    if (payload.work_performed !== undefined) {
      await client.query(`UPDATE work_orders SET work_performed = $2 WHERE id = $1::uuid`, [id, clean(payload.work_performed)]);
    }
    if (png && payload.signed_by_name) {
      await saveSignature(client, id, payload.signed_by_name, png);
    }

    const state = await client.query(`SELECT work_performed FROM work_orders WHERE id = $1::uuid`, [id]);
    if (!clean(state.rows[0].work_performed)) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Describe the work performed before completing the work order!");
    }
    const missing = await client.query(
      `SELECT text FROM work_order_checklist WHERE work_order_id = $1::uuid AND is_required AND NOT is_done ORDER BY sort_order ASC LIMIT 5`,
      [id],
    );
    if (missing.rows.length > 0) {
      throw new ApiError(
        httpStatus.CONFLICT,
        `Complete the checklist first: ${missing.rows.map((r: any) => r.text).join("; ")}`,
      );
    }

    await client.query(
      `UPDATE work_orders SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, completed_by = $2::uuid, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, actor.id],
    );
    const project = await projectContext(client, workOrder.project_id);
    await logWorkOrderEvent(client, workOrder, project.relation_id, "WORK_ORDER_COMPLETED", `Work order ${workOrder.number} completed`, actor.id);
    await logAudit(
      { actor_id: actor.id, action: "STATUS_CHANGE", entity_type: "work_order", entity_id: id, changes: { to: "COMPLETED" } },
      client,
    );
    return true;
  });

  if (done) {
    // Neither of these may undo a completion that is already saved
    await generatePdf(id).catch((error) => console.error("❌ Could not create the work order PDF:", error));
    await notifyOffice(id, actor).catch((error) => console.error("❌ Could not notify the office:", error));
  }

  return viewFor(actor, id);
};

// The office is told when the crew finishes (FR-WO-06): the project manager, or else
// everyone in the office.
const notifyOffice = async (id: string, actor: IActor) => {
  const info = await query(
    `
      SELECT w.number, w.completed_at, p.title AS project_title, p.id AS project_id, p.project_manager_id,
             u.name AS crew_name
      FROM work_orders w
      JOIN projects p ON p.id = w.project_id
      LEFT JOIN users u ON u.id = w.completed_by
      WHERE w.id = $1::uuid
    `,
    [id],
  );
  const w = info.rows[0];
  if (!w) return;

  const recipients = await query(
    `
      SELECT id, name, email, preferred_language FROM users
      WHERE is_active AND status = 'ACTIVE' AND role IN ('ADMIN', 'OFFICE') AND id <> $1::uuid
        AND ($2::uuid IS NULL OR id = $2::uuid)
    `,
    [actor.id, w.project_manager_id],
  );
  // A manager who completed it themselves, or who is no longer active: tell the whole office
  const list =
    recipients.rows.length > 0 || !w.project_manager_id
      ? recipients.rows
      : (
          await query(
            `SELECT id, name, email, preferred_language FROM users WHERE is_active AND status = 'ACTIVE' AND role IN ('ADMIN', 'OFFICE') AND id <> $1::uuid`,
            [actor.id],
          )
        ).rows;

  for (const user of list) {
    const language = toLanguage(user.preferred_language);
    try {
      await sendTemplatedEmail({
        to: user.email,
        templateKey: "work_order_completed",
        language,
        variables: {
          name: user.name,
          work_order_number: w.number,
          project: w.project_title,
          crew: w.crew_name ?? "",
          completed_at: formatDate(w.completed_at, language),
          link: `${config.frontend_url}/work-orders/${id}`,
        },
        related: { type: "work_order", id },
        sentBy: actor.id,
      });
    } catch (error) {
      console.error("❌ Could not email", user.email, error);
    }
  }
};

// Marked as checked by the office (Gecontroleerd)
const checkWorkOrder = async (id: string, actorId: string) => {
  await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    if (workOrder.status === "CHECKED") {
      throw new ApiError(httpStatus.CONFLICT, "This work order has already been checked!");
    }
    if (workOrder.status !== "COMPLETED") {
      throw new ApiError(httpStatus.CONFLICT, "Only a completed work order can be checked!");
    }
    await client.query(
      `UPDATE work_orders SET status = 'CHECKED', checked_at = CURRENT_TIMESTAMP, checked_by = $2::uuid, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, actorId],
    );
    const project = await projectContext(client, workOrder.project_id);
    await logWorkOrderEvent(client, workOrder, project.relation_id, "WORK_ORDER_CHECKED", `Work order ${workOrder.number} checked`, actorId);
    await logAudit(
      { actor_id: actorId, action: "STATUS_CHANGE", entity_type: "work_order", entity_id: id, changes: { to: "CHECKED" } },
      client,
    );
  });

  return getWorkOrderById(id);
};

// Back to In uitvoering: the crew can correct it. The old signature and PDF no longer
// describe the work, so they are dropped.
const reopenWorkOrder = async (id: string, reason: string, actorId: string) => {
  const oldPdf = await transaction(async (client) => {
    const workOrder = await lockWorkOrder(client, id);
    if (workOrder.status !== "COMPLETED" && workOrder.status !== "CHECKED") {
      throw new ApiError(httpStatus.CONFLICT, "Only a completed work order can be reopened!");
    }
    const project = await projectContext(client, workOrder.project_id);
    if (project.closed_at) {
      throw new ApiError(httpStatus.CONFLICT, "The project is closed. Reopen the project first!");
    }

    await client.query(
      `
        UPDATE work_orders
        SET status = 'IN_PROGRESS', completed_at = NULL, completed_by = NULL, checked_at = NULL, checked_by = NULL,
            signed_by_name = NULL, signed_at = NULL, signature_png = NULL,
            pdf_data = NULL, pdf_generated_at = NULL, sent_to_customer_at = NULL, sent_to = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [id],
    );
    const removed = await client.query(
      `DELETE FROM project_files WHERE work_order_id = $1::uuid AND mime_type = 'application/pdf' RETURNING storage_key`,
      [id],
    );
    await logWorkOrderEvent(client, workOrder, project.relation_id, "WORK_ORDER_REOPENED", `Work order ${workOrder.number} reopened`, actorId, {
      description: reason.trim(),
    });
    await logAudit(
      { actor_id: actorId, action: "STATUS_CHANGE", entity_type: "work_order", entity_id: id, changes: { to: "IN_PROGRESS", reason: reason.trim() } },
      client,
    );
    return removed.rows.map((r: any) => r.storage_key as string);
  });

  for (const key of oldPdf) {
    try {
      await S3Uploader.deleteFromS3(key);
    } catch (error) {
      console.error("❌ Could not delete file from storage:", key, error);
    }
  }

  return getWorkOrderById(id);
};

// ---------------------------------------------------------------------------
// PDF (FR-WO-04) and sending it to the customer
// ---------------------------------------------------------------------------

// Builds the PDF of a completed work order, keeps it and stores a copy in the project's
// documents (replacing the earlier copy).
const generatePdf = async (id: string) => {
  const found = await query(
    `
      SELECT w.id, w.number, w.title, w.instructions, w.planned_date::text AS planned_date, w.completed_at, w.work_performed,
             w.street, w.house_number, w.postcode, w.city, w.signed_by_name, w.signed_at, w.signature_png,
             w.project_id, w.completed_by, p.number AS project_number, p.title AS project_title,
             r.name AS customer_name, r.preferred_language
      FROM work_orders w
      JOIN projects p ON p.id = w.project_id
      JOIN relations r ON r.id = p.relation_id
      WHERE w.id = $1::uuid AND w.status IN ('COMPLETED', 'CHECKED')
    `,
    [id],
  );
  if (found.rows.length === 0) return null;
  const w = found.rows[0];

  const children = await loadChildren(id);
  const crew = await query(
    `SELECT u.name FROM work_order_assignees wa JOIN users u ON u.id = wa.user_id WHERE wa.work_order_id = $1::uuid ORDER BY u.name`,
    [id],
  );
  const company = await SettingsService.getCompanySettings();
  const logo = await loadLogo(company.logo_url);
  const language = toLanguage(w.preferred_language);

  const pdf = await buildWorkOrderPdf(
    {
      number: w.number,
      title: w.title,
      instructions: w.instructions,
      planned_date: w.planned_date,
      completed_at: w.completed_at,
      project: { number: w.project_number, title: w.project_title },
      customer_name: w.customer_name,
      address_lines: addressLines(w),
      crew: crew.rows.map((c: any) => c.name),
      checklist: children.checklist.map((c: any) => ({ text: c.text, is_done: c.is_done })),
      materials: children.materials.map((m: any) => ({
        description: m.description,
        unit: m.unit,
        quantity_planned: m.quantity_planned,
        quantity_used: m.quantity_used,
      })),
      work_performed: w.work_performed,
      // Customer PDF: only approved hours
      hours: children.hours.filter((h: any) => h.status === "APPROVED").map((h: any) => ({ employee: h.user_name, work_date: h.work_date, entry_type: h.entry_type, minutes: h.minutes })),
      photo_count: children.photos.length,
      signature: w.signature_png ? { name: w.signed_by_name, signed_at: w.signed_at, png: w.signature_png } : null,
    },
    company,
    language,
    { logo },
  );

  await query(`UPDATE work_orders SET pdf_data = $2, pdf_generated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id, pdf]);

  // A copy in the project's documents; the stored PDF above stays the source if storage is down
  try {
    const uploaded = await S3Uploader.uploadToS3(
      { buffer: pdf, originalname: `${w.number}.pdf`, mimetype: "application/pdf" } as any,
      `projects/${w.project_id}`,
    );
    const old = await query(
      `SELECT id, storage_key FROM project_files WHERE work_order_id = $1::uuid AND mime_type = 'application/pdf'`,
      [id],
    );
    await query(
      `
        INSERT INTO project_files (project_id, work_order_id, folder, file_url, storage_key, file_name, mime_type, size_bytes, caption, uploaded_by)
        VALUES ($1::uuid, $2::uuid, 'AFTER', $3, $4, $5, 'application/pdf', $6, $7, $8::uuid)
      `,
      [w.project_id, id, uploaded.Location, uploaded.Key, `${w.number}.pdf`, pdf.length, `Work order ${w.number}`, w.completed_by],
    );
    for (const row of old.rows) {
      await query(`DELETE FROM project_files WHERE id = $1::uuid`, [row.id]);
      try {
        await S3Uploader.deleteFromS3(row.storage_key);
      } catch (error) {
        console.error("❌ Could not delete file from storage:", row.storage_key, error);
      }
    }
  } catch (error) {
    console.error("❌ Could not store the work order PDF on the project:", error);
  }

  return pdf;
};

const getPdf = async (id: string, actor: IActor) => {
  assertUuid(id, "work order id");
  const found = await query(`SELECT id, number, status, (pdf_data IS NOT NULL) AS has_pdf FROM work_orders WHERE id = $1::uuid`, [id]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Work order not found!");
  }
  await assertAccess({ query } as any, id, actor);
  const w = found.rows[0];
  if (w.status !== "COMPLETED" && w.status !== "CHECKED") {
    throw new ApiError(httpStatus.CONFLICT, "The PDF is made when the work order is completed!");
  }

  let pdf: Buffer | null = null;
  if (w.has_pdf) {
    const stored = await query(`SELECT pdf_data FROM work_orders WHERE id = $1::uuid`, [id]);
    pdf = stored.rows[0].pdf_data;
  } else {
    pdf = await generatePdf(id);
  }
  if (!pdf) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "The PDF could not be created.");
  }
  return { pdf, filename: `${w.number}.pdf` };
};

// Emails the completed work order to the customer (FR-WO-04)
const sendToCustomer = async (id: string, emailOverride: string | undefined, actorId: string) => {
  assertUuid(id, "work order id");
  const found = await query(
    `
      SELECT w.id, w.number, w.status, w.completed_at, w.project_id, p.title AS project_title,
             p.contact_name, p.contact_email, r.name AS relation_name, r.email AS relation_email, r.preferred_language, r.invoice_email
      FROM work_orders w JOIN projects p ON p.id = w.project_id JOIN relations r ON r.id = p.relation_id
      WHERE w.id = $1::uuid
    `,
    [id],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Work order not found!");
  }
  const w = found.rows[0];
  if (w.status !== "COMPLETED" && w.status !== "CHECKED") {
    throw new ApiError(httpStatus.CONFLICT, "Only a completed work order can be sent to the customer!");
  }

  const to = clean(emailOverride)?.toLowerCase() ?? w.contact_email ?? w.relation_email ?? w.invoice_email ?? null;
  if (!to) {
    throw new ApiError(httpStatus.BAD_REQUEST, "There is no email address to send the work order to!");
  }

  const { pdf, filename } = await getPdf(id, { id: actorId, role: "ADMIN" });
  const language = toLanguage(w.preferred_language);

  // Sent first; only a delivered email is recorded as sent
  await sendTemplatedEmail({
    to,
    templateKey: "work_order",
    language,
    variables: {
      name: w.contact_name ?? w.relation_name,
      work_order_number: w.number,
      project: w.project_title,
      date: formatDate(w.completed_at, language),
    },
    attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
    related: { type: "work_order", id },
    sentBy: actorId,
  });

  await transaction(async (client) => {
    await client.query(`UPDATE work_orders SET sent_to_customer_at = CURRENT_TIMESTAMP, sent_to = $2 WHERE id = $1::uuid`, [id, to]);
    const project = await projectContext(client, w.project_id);
    await logWorkOrderEvent(client, { id }, project.relation_id, "WORK_ORDER_SENT", `Work order ${w.number} sent to ${to}`, actorId);
  });

  return getWorkOrderById(id);
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const getHistory = async (id: string, params: Record<string, any>) => {
  assertUuid(id, "work order id");
  const exists = await query(`SELECT 1 FROM work_orders WHERE id = $1::uuid`, [id]);
  if (exists.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Work order not found!");
  }

  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const scope = `t.entity_type = 'work_order' AND t.entity_id = $1::uuid`;

  const [result, count] = await Promise.all([
    query(
      `
        SELECT t.id, t.event_type, t.entity_id, t.title, t.description, t.metadata, t.actor_id,
               u.name AS actor_name, t.created_at AS "createdAt"
        FROM relation_timeline t
        LEFT JOIN users u ON u.id = t.actor_id
        WHERE ${scope}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $2 OFFSET $3
      `,
      [id, limit, skip],
    ),
    query(`SELECT COUNT(*) AS total FROM relation_timeline t WHERE ${scope}`, [id]),
  ]);

  const total = parseInt(count.rows[0].total);
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

// The customer PDF lists approved hours only, so it is made again when hours of a finished
// work order are approved or unapproved. Never throws: it must not undo the approval.
const refreshPdfForHours = async (entryIds: string[]) => {
  try {
    if (entryIds.length === 0) return;
    const found = await query(
      `SELECT DISTINCT t.work_order_id AS id FROM time_entries t JOIN work_orders w ON w.id = t.work_order_id
       WHERE t.id = ANY($1::uuid[]) AND w.status IN ('COMPLETED', 'CHECKED') AND w.pdf_data IS NOT NULL`,
      [entryIds],
    );
    for (const row of found.rows) {
      await generatePdf(row.id).catch((error) => console.error("❌ Could not refresh the work order PDF:", error));
    }
  } catch (error) {
    console.error("❌ Could not refresh work order PDFs:", error);
  }
};

export const WorkOrderService = {
  refreshPdfForHours,
  createWorkOrder,
  getAllWorkOrders,
  getWorkOrderById,
  getMyWorkOrders,
  getMyWorkOrderById,
  updateWorkOrder,
  deleteWorkOrder,
  setChecklist,
  setMaterials,
  startWorkOrder,
  syncWorkOrder,
  addHours,
  updateHours,
  deleteHours,
  addPhotos,
  deletePhoto,
  setSignature,
  completeWorkOrder,
  checkWorkOrder,
  reopenWorkOrder,
  getPdf,
  sendToCustomer,
  getHistory,
};

