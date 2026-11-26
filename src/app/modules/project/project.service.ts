import { announceProject } from "../chat/chat.live";
import { ensureChannels } from "../chat/chat.shared";
import path from "path";
import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { S3Uploader } from "../../lib/S3Uploader";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { isValidDay } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { detectFileType } from "../../utils/fileType";
import { fromCents, toCents } from "../../utils/money";
import normalizePostcode from "../../utils/normalizePostcode";
import { resolveServiceTypeId } from "../../utils/serviceTypes";
import {
  calculateLine,
  calculateTotals,
  ICalcLine,
  marginPercent,
  totalsToAmounts,
} from "../quote/quote.calculation";
import { IQuoteSectionInput } from "../quote/quote.interface";
import { MessageService } from "../messages/message.service";
import { QuoteService } from "../quote/quote.service";
import { RelationService } from "../relation/relation.service";
import { SettingsService } from "../settings/settings.service";
import {
  IAdditionalWorkInput,
  IChangeProjectStatus,
  ICreateProject,
  IUpdateProject,
  projectFolders,
} from "./project.interface";
import { TRelationEventType } from "../relation/relation.interface";

// Projecten (SRS 4.8). An accepted quotation becomes a project: the job that is
// planned, executed, extended with additional work (meerwerk) and finally invoiced
// and closed. The quotation's lines become the project's budget (FR-PRJ-04).

const MAX_FILES_PER_PROJECT = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const customerTypes = ["PRIVATE", "BUSINESS", "VVE"];
const staffRoles = ["SUPERADMIN", "ADMIN", "OFFICE"];

const clean = (value: any) =>
  typeof value === "string"
    ? value.trim() === ""
      ? null
      : value.trim()
    : (value ?? null);

const run = (client?: any) => (client ? client.query.bind(client) : query);

const asList = (value: any): string[] =>
  String(Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const normalizeAddress = (a: any) => ({
  street: a.street.trim(),
  house_number: a.house_number.trim(),
  postcode: normalizePostcode(a.postcode),
  city: a.city.trim(),
  country: (a.country ?? "NL").toUpperCase(),
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const projectColumns = `
  p.id, p.number, p.title, p.description,
  p.street, p.house_number, p.postcode, p.city, p.country,
  to_char(p.planned_start, 'YYYY-MM-DD') AS planned_start,
  to_char(p.planned_end, 'YYYY-MM-DD') AS planned_end,
  p.contact_name, p.contact_email, p.contact_phone,
  p.project_manager_id, p.internal_notes,
  p.budget_excl_vat::float8 AS budget_excl_vat,
  p.budget_vat::float8 AS budget_vat,
  p.budget_incl_vat::float8 AS budget_incl_vat,
  p.budget_cost::float8 AS budget_cost,
  p.additional_excl_vat::float8 AS additional_excl_vat,
  p.additional_vat::float8 AS additional_vat,
  p.additional_incl_vat::float8 AS additional_incl_vat,
  p.additional_cost::float8 AS additional_cost,
  (p.budget_excl_vat + p.additional_excl_vat)::float8 AS total_excl_vat,
  (p.budget_incl_vat + p.additional_incl_vat)::float8 AS total_incl_vat,
  p.closed_at, p.created_by,
  p.created_at AS "createdAt", p.updated_at AS "updatedAt",
  json_build_object(
    'id', s.id, 'key', s.key, 'label_nl', s.label_nl, 'label_en', s.label_en,
    'kind', s.kind, 'color', s.color
  ) AS status,
  json_build_object(
    'id', r.id, 'name', r.name, 'type', r.type, 'email', r.email, 'phone', r.phone,
    'preferred_language', r.preferred_language
  ) AS relation,
  CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object(
    'id', st.id, 'key', st.key, 'label_nl', st.label_nl, 'label_en', st.label_en
  ) END AS service_type,
  CASE WHEN q.id IS NULL THEN NULL ELSE json_build_object(
    'id', q.id, 'number', q.number, 'revision', q.revision
  ) END AS quote,
  CASE WHEN i.id IS NULL THEN NULL ELSE json_build_object(
    'id', i.id, 'reference', i.reference
  ) END AS inquiry,
  CASE WHEN m.id IS NULL THEN NULL ELSE json_build_object(
    'id', m.id, 'name', m.name, 'email', m.email
  ) END AS project_manager
`;

const projectListColumns = `
  p.id, p.number, p.title, p.city,
  to_char(p.planned_start, 'YYYY-MM-DD') AS planned_start,
  to_char(p.planned_end, 'YYYY-MM-DD') AS planned_end,
  (p.budget_excl_vat + p.additional_excl_vat)::float8 AS total_excl_vat,
  (p.budget_incl_vat + p.additional_incl_vat)::float8 AS total_incl_vat,
  (p.additional_excl_vat <> 0) AS has_additional_work,
  p.closed_at, p.created_at AS "createdAt",
  json_build_object('id', s.id, 'key', s.key, 'label_nl', s.label_nl, 'label_en', s.label_en, 'kind', s.kind, 'color', s.color) AS status,
  json_build_object('id', r.id, 'name', r.name, 'type', r.type) AS relation,
  CASE WHEN m.id IS NULL THEN NULL ELSE json_build_object('id', m.id, 'name', m.name) END AS project_manager,
  CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object('id', st.id, 'key', st.key, 'label_nl', st.label_nl, 'label_en', st.label_en) END AS service_type,
  CASE WHEN q.id IS NULL THEN NULL ELSE json_build_object('id', q.id, 'number', q.number) END AS quote
`;

const projectJoins = `
  JOIN project_statuses s ON s.id = p.status_id
  JOIN relations r ON r.id = p.relation_id
  LEFT JOIN service_types st ON st.id = p.service_type_id
  LEFT JOIN quotes q ON q.id = p.quote_id
  LEFT JOIN inquiries i ON i.id = p.inquiry_id
  LEFT JOIN users m ON m.id = p.project_manager_id
`;

const lineColumns = `
  id, kind, section_title, sort_order, catalogue_item_id, description,
  quantity::float8 AS quantity, unit,
  unit_price::float8 AS unit_price, cost_price::float8 AS cost_price,
  vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge,
  line_total::float8 AS line_total, line_cost::float8 AS line_cost,
  added_by, created_at AS "createdAt"
`;

const fileColumns = `
  id, project_id, work_order_id, subcontract_assignment_id, folder, file_url, file_name, mime_type, size_bytes, caption,
  share_with_customer, share_with_subcontractor, uploaded_by, created_at AS "createdAt"
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Locks the project row (a single-table select, so there is no wrongly re-checked join)
const lockProject = async (client: any, id: string) => {
  assertUuid(id, "project id");
  const result = await client.query(
    `
      SELECT id, number, relation_id, status_id, quote_id, closed_at
      FROM projects WHERE id = $1::uuid FOR UPDATE
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }
  return result.rows[0];
};

const assertOpen = (project: { closed_at: any }) => {
  if (project.closed_at) {
    throw new ApiError(
      httpStatus.CONFLICT,
      "This project is closed. Reopen it by changing its status first!",
    );
  }
};

const logProjectEvent = (
  client: any,
  project: { id: string; relation_id: string },
  eventType: TRelationEventType,
  title: string,
  actorId: string | null,
  extra: { description?: string | null; metadata?: Record<string, any> } = {},
) =>
  RelationService.logRelationEvent(
    project.relation_id,
    {
      event_type: eventType,
      entity_type: "project",
      entity_id: project.id,
      title,
      description: extra.description ?? null,
      metadata: extra.metadata,
      actor_id: actorId,
    },
    client,
  );

const toCalc = (l: any): ICalcLine => ({
  quantity: l.quantity,
  unit_price: l.unit_price,
  cost_price: l.cost_price,
  vat_code: l.vat_code,
  vat_rate: l.vat_rate,
  vat_reverse_charge: l.vat_reverse_charge,
});

// Writes the stored budget / additional-work totals from the current lines. Called in
// the same transaction as every change to the lines.
const recomputeTotals = async (client: any, projectId: string) => {
  const lines = await client.query(
    `SELECT kind, quantity::float8 AS quantity, unit_price::float8 AS unit_price,
            cost_price::float8 AS cost_price, vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge
     FROM project_lines WHERE project_id = $1::uuid`,
    [projectId],
  );
  const budget = calculateTotals(
    lines.rows.filter((l: any) => l.kind === "BUDGET").map(toCalc),
  );
  const additional = calculateTotals(
    lines.rows.filter((l: any) => l.kind === "ADDITIONAL").map(toCalc),
  );

  await client.query(
    `
      UPDATE projects SET
        budget_excl_vat = $2, budget_vat = $3, budget_incl_vat = $4, budget_cost = $5,
        additional_excl_vat = $6, additional_vat = $7, additional_incl_vat = $8, additional_cost = $9,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid
    `,
    [
      projectId,
      fromCents(budget.subtotalCents),
      fromCents(budget.totalVatCents),
      fromCents(budget.totalCents),
      fromCents(budget.costCents),
      fromCents(additional.subtotalCents),
      fromCents(additional.totalVatCents),
      fromCents(additional.totalCents),
      fromCents(additional.costCents),
    ],
  );
};

const insertLine = async (
  client: any,
  projectId: string,
  kind: "BUDGET" | "ADDITIONAL",
  sectionTitle: string | null,
  sortOrder: number,
  line: any,
  actorId: string | null,
) => {
  const calc = calculateLine(line);
  const result = await client.query(
    `
      INSERT INTO project_lines (
        project_id, kind, section_title, sort_order, catalogue_item_id, description,
        quantity, unit, unit_price, cost_price, vat_code, vat_rate, vat_reverse_charge,
        line_total, line_cost, added_by
      ) VALUES (
        $1::uuid, $2, $3, $4, $5::uuid, $6,
        $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16::uuid
      ) RETURNING id
    `,
    [
      projectId,
      kind,
      sectionTitle,
      sortOrder,
      line.catalogue_item_id ?? null,
      line.description,
      line.quantity,
      line.unit,
      line.unit_price,
      line.cost_price,
      line.vat_code,
      line.vat_rate,
      line.vat_reverse_charge,
      fromCents(calc.totalCents),
      fromCents(calc.costCents),
      actorId,
    ],
  );
  return result.rows[0].id as string;
};

const insertSections = async (
  client: any,
  projectId: string,
  kind: "BUDGET" | "ADDITIONAL",
  sections: { title: string | null; lines: any[] }[],
  actorId: string | null,
) => {
  let order = 0;
  for (const section of sections) {
    for (const line of section.lines) {
      await insertLine(
        client,
        projectId,
        kind,
        section.title,
        order++,
        line,
        actorId,
      );
    }
  }
};

const nextSortOrder = async (client: any, projectId: string, kind: string) => {
  const result = await client.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM project_lines WHERE project_id = $1::uuid AND kind = $2`,
    [projectId, kind],
  );
  return Number(result.rows[0].next);
};

const groupBySection = (lines: any[]) => {
  const sections: { title: string | null; lines: any[] }[] = [];
  for (const line of lines) {
    const last = sections[sections.length - 1];
    if (last && last.title === line.section_title) last.lines.push(line);
    else sections.push({ title: line.section_title, lines: [line] });
  }
  return sections;
};

const withMargin = (l: any) => {
  const margin = Math.round((l.line_total - l.line_cost) * 100) / 100;
  return {
    ...l,
    margin,
    margin_percent: marginPercent(toCents(margin), toCents(l.line_total)),
  };
};

const assertManager = async (userId: string, client?: any) => {
  assertUuid(userId, "user id");
  const result = await run(client)(
    `SELECT role::text AS role, (is_active AND status = 'ACTIVE') AS is_active FROM users WHERE id = $1::uuid`,
    [userId],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project manager not found!");
  }
  if (!staffRoles.includes(result.rows[0].role) || !result.rows[0].is_active) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "The project manager must be an active office or admin user!",
    );
  }
};

const getStatusByKey = async (key: string, client?: any) => {
  const result = await run(client)(
    `SELECT id, key, label_nl, label_en, kind, is_active FROM project_statuses WHERE key = $1`,
    [key],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Unknown status!");
  }
  if (!result.rows[0].is_active) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "This status is no longer available!",
    );
  }
  return result.rows[0];
};

const getStartStatus = async (client: any) => {
  const result = await client.query(
    `SELECT id FROM project_statuses WHERE kind = 'NEW' AND is_active ORDER BY sort_order ASC LIMIT 1`,
  );
  if (result.rows.length === 0) {
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "No starting status is configured for projects!",
    );
  }
  return result.rows[0].id as string;
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const getProjectById = async (id: string) => {
  assertUuid(id, "project id");

  const result = await query(
    `SELECT ${projectColumns} FROM projects p ${projectJoins} WHERE p.id = $1::uuid`,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }

  const [
    lines,
    files,
    appointments,
    workOrders,
    invoices,
    purchaseOrders,
    supplierInvoices,
    subcontractAssignments,
    comments,
  ] = await Promise.all([
    query(
      `SELECT ${lineColumns} FROM project_lines WHERE project_id = $1::uuid ORDER BY kind ASC, sort_order ASC`,
      [id],
    ),
    query(
      `SELECT ${fileColumns} FROM project_files WHERE project_id = $1::uuid ORDER BY created_at ASC`,
      [id],
    ),
    query(
      `
        SELECT a.id, a.type, a.status, a.title, a.starts_at, a.ends_at, a.all_day,
               COALESCE(
                 (SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
                  FROM appointment_assignees aa JOIN users u ON u.id = aa.user_id
                  WHERE aa.appointment_id = a.id), '[]'::json
               ) AS assignees
        FROM appointments a
        WHERE a.project_id = $1::uuid
        ORDER BY a.starts_at ASC
      `,
      [id],
    ),
    query(
      `
        SELECT w.id, w.number, w.title, w.status, w.planned_date::text AS planned_date, w.completed_at,
               COALESCE(
                 (SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
                  FROM work_order_assignees wa JOIN users u ON u.id = wa.user_id
                  WHERE wa.work_order_id = w.id), '[]'::json
               ) AS assignees
        FROM work_orders w
        WHERE w.project_id = $1::uuid
        ORDER BY w.created_at ASC
      `,
      [id],
    ),
    query(
      `
        SELECT i.id, i.number, i.kind, i.status, i.payment_status, i.total_incl_vat::float8 AS total_incl_vat,
               to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
               (i.status = 'ISSUED' AND i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID')
                AND i.due_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Amsterdam')::date) AS is_overdue
        FROM invoices i WHERE i.project_id = $1::uuid ORDER BY i.created_at ASC
      `,
      [id],
    ),
    query(
      `
        SELECT po.id, po.number, po.status, po.title, s.name AS supplier, po.total_excl_vat::float8 AS total_excl_vat,
               to_char(po.expected_delivery_date, 'YYYY-MM-DD') AS expected_delivery_date
        FROM purchase_orders po JOIN relations s ON s.id = po.supplier_id
        WHERE po.project_id = $1::uuid ORDER BY po.created_at ASC
      `,
      [id],
    ),
    query(
      `
        SELECT si.id, si.invoice_number, si.status, s.name AS supplier, si.amount_excl_vat::float8 AS amount_excl_vat,
               to_char(si.due_date, 'YYYY-MM-DD') AS due_date, si.subcontract_assignment_id
        FROM supplier_invoices si JOIN relations s ON s.id = si.supplier_id
        WHERE si.project_id = $1::uuid ORDER BY si.created_at ASC
      `,
      [id],
    ),
    query(
      `
        SELECT sa.id, sa.number, sa.status, sa.title, s.name AS subcontractor, sa.agreed_price_excl_vat::float8 AS agreed_price_excl_vat,
               sa.progress_percent, to_char(sa.planned_start, 'YYYY-MM-DD') AS planned_start, to_char(sa.planned_end, 'YYYY-MM-DD') AS planned_end
        FROM subcontract_assignments sa JOIN relations s ON s.id = sa.subcontractor_id
        WHERE sa.project_id = $1::uuid ORDER BY sa.created_at ASC
      `,
      [id],
    ),
    // Office comments of the whole file (inquiry, quotations, this project and what hangs on it)
    MessageService.getCommentsOfRecord("project", id),
  ]);

  const budgetLines = lines.rows
    .filter((l: any) => l.kind === "BUDGET")
    .map(withMargin);
  const additionalLines = lines.rows
    .filter((l: any) => l.kind === "ADDITIONAL")
    .map(withMargin);
  const budgetCalc = calculateTotals(budgetLines.map(toCalc));
  const additionalCalc = calculateTotals(additionalLines.map(toCalc));
  const totalCalc = calculateTotals(
    [...budgetLines, ...additionalLines].map(toCalc),
  );

  return {
    ...result.rows[0],
    budget_sections: groupBySection(budgetLines),
    additional_work: additionalLines,
    budget_calculation: totalsToAmounts(budgetCalc),
    additional_calculation: totalsToAmounts(additionalCalc),
    total_calculation: totalsToAmounts(totalCalc),
    files: files.rows,
    appointments: appointments.rows,
    work_orders: workOrders.rows,
    invoices: invoices.rows,
    purchase_orders: purchaseOrders.rows,
    supplier_invoices: supplierInvoices.rows,
    subcontract_assignments: subcontractAssignments.rows,
    comments: comments.data,
    comments_total: comments.total,
  };
};

const getAllProjects = async (params: Record<string, any>, actorId: string) => {
  const { page, limit, skip, sortBy, sortOrder } =
    paginationHelper.calculatePagination(params as any);

  const sortable: Record<string, string> = {
    created_at: "p.created_at",
    number: "p.number",
    title: "LOWER(p.title)",
    planned_start: "p.planned_start",
    planned_end: "p.planned_end",
    total: "(p.budget_incl_vat + p.additional_incl_vat)",
    status: "s.sort_order",
  };
  const orderColumn = sortable[sortBy] ?? "p.created_at";
  const orderDirection = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  const conditions: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  if (params.searchTerm) {
    const term = String(
      Array.isArray(params.searchTerm)
        ? params.searchTerm[0]
        : params.searchTerm,
    )
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(
      `(p.number ILIKE $${paramCount} OR p.title ILIKE $${paramCount} OR p.city ILIKE $${paramCount}
        OR r.name ILIKE $${paramCount} OR q.number ILIKE $${paramCount})`,
    );
    values.push(`%${term}%`);
    paramCount++;
  }

  if (params.status) {
    conditions.push(`s.key = ANY($${paramCount++}::text[])`);
    values.push(asList(params.status));
  }

  if (params.kind) {
    const kinds = asList(params.kind).map((k) => k.toUpperCase());
    if (kinds.some((k) => !["NEW", "OPEN", "CLOSED"].includes(k))) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Kind should be NEW, OPEN or CLOSED!",
      );
    }
    conditions.push(`s.kind = ANY($${paramCount++}::text[])`);
    values.push(kinds);
  }

  if (params.relation_id) {
    assertUuid(String(params.relation_id), "relation id");
    conditions.push(`p.relation_id = $${paramCount++}::uuid`);
    values.push(String(params.relation_id));
  }

  if (params.manager) {
    const manager = String(params.manager);
    if (manager === "none") {
      conditions.push(`p.project_manager_id IS NULL`);
    } else {
      const id = manager === "me" ? actorId : manager;
      assertUuid(id, "manager id");
      conditions.push(`p.project_manager_id = $${paramCount++}::uuid`);
      values.push(id);
    }
  }

  if (params.service_type) {
    conditions.push(`st.key = ANY($${paramCount++}::text[])`);
    values.push(asList(params.service_type));
  }

  for (const [param, column, operator] of [
    ["planned_from", "p.planned_start", ">="],
    ["planned_to", "p.planned_start", "<="],
    [
      "created_from",
      "(p.created_at AT TIME ZONE 'Europe/Amsterdam')::date",
      ">=",
    ],
    [
      "created_to",
      "(p.created_at AT TIME ZONE 'Europe/Amsterdam')::date",
      "<=",
    ],
  ] as const) {
    if (params[param]) {
      const day = String(params[param]);
      if (!isValidDay(day)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${param} must be a date like 2026-11-30!`,
        );
      }
      conditions.push(`${column} ${operator} $${paramCount++}::date`);
      values.push(day);
    }
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const [result, count] = await Promise.all([
    query(
      `
        SELECT ${projectListColumns}
        FROM projects p ${projectJoins}
        ${whereClause}
        ORDER BY ${orderColumn} ${orderDirection}, p.id ASC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      `,
      [...values, limit, skip],
    ),
    query(
      `SELECT COUNT(*) AS total FROM projects p ${projectJoins} ${whereClause}`,
      values,
    ),
  ]);

  const total = parseInt(count.rows[0].total);
  const totalPage = Math.ceil(total / limit);

  return {
    data: result.rows,
    meta: {
      page,
      limit,
      total,
      totalPage,
      hasNextPage: page < totalPage,
      hasPrevPage: page > 1,
    },
  };
};

// Counts per status and the value still open, for the dashboard
const getSummary = async () => {
  const result = await query(
    `
      SELECT s.id, s.key, s.label_nl, s.label_en, s.kind, s.color, s.sort_order,
             COUNT(p.id)::int AS project_count,
             COALESCE(SUM(p.budget_excl_vat + p.additional_excl_vat), 0)::float8 AS total_excl_vat,
             COALESCE(SUM(p.budget_incl_vat + p.additional_incl_vat), 0)::float8 AS total_incl_vat
      FROM project_statuses s
      LEFT JOIN projects p ON p.status_id = s.id
      WHERE s.is_active OR p.id IS NOT NULL
      GROUP BY s.id
      ORDER BY s.sort_order ASC, s.label_en ASC
    `,
  );

  const rows = result.rows;
  const open = rows.filter((r: any) => r.kind !== "CLOSED");
  const sum = (key: "project_count" | "total_excl_vat" | "total_incl_vat") =>
    Math.round(open.reduce((n: number, r: any) => n + r[key], 0) * 100) / 100;

  return {
    statuses: rows,
    open: {
      project_count: sum("project_count"),
      total_excl_vat: sum("total_excl_vat"),
      total_incl_vat: sum("total_incl_vat"),
    },
  };
};

// ---------------------------------------------------------------------------
// Create / update / delete (FR-PRJ-01)
// ---------------------------------------------------------------------------

const createProject = async (input: ICreateProject, actorId: string) => {
  if (input.project_manager_id) await assertManager(input.project_manager_id);

  const projectId = await transaction(async (client) => {
    let quote: any = null;
    let relationId: string;
    let inquiryId: string | null = null;
    let serviceTypeId: string | null = null;
    let title: string | undefined = clean(input.title) ?? undefined;
    let address: any = null;
    let contact = {
      name: clean(input.contact_name),
      email: clean(input.contact_email)?.toLowerCase() ?? null,
      phone: clean(input.contact_phone),
    };
    let quoteSections: { title: string | null; lines: any[] }[] | null = null;

    if (input.quote_id) {
      assertUuid(input.quote_id, "quote id");
      const found = await client.query(
        `
          SELECT id, number, revision, status, is_current, relation_id, inquiry_id, service_type_id, title,
                 street, house_number, postcode, city, country, recipient_name, recipient_email
          FROM quotes WHERE id = $1::uuid FOR UPDATE
        `,
        [input.quote_id],
      );
      if (found.rows.length === 0) {
        throw new ApiError(httpStatus.NOT_FOUND, "Quotation not found!");
      }
      quote = found.rows[0];
      if (quote.status !== "ACCEPTED" || !quote.is_current) {
        throw new ApiError(
          httpStatus.CONFLICT,
          "A project can only be created from an accepted quotation!",
        );
      }
      const existing = await client.query(
        `SELECT id, number FROM projects WHERE quote_id = $1::uuid`,
        [quote.id],
      );
      if (existing.rows.length > 0) {
        throw new ApiError(
          httpStatus.CONFLICT,
          `This quotation already has project ${existing.rows[0].number}!`,
        );
      }

      // A quotation that was already invoiced directly would be billed twice
      const invoiced = await client.query(
        `SELECT number FROM invoices WHERE quote_id = $1::uuid AND kind <> 'CREDIT_NOTE' AND payment_status IS DISTINCT FROM 'CREDITED'`,
        [quote.id],
      );
      if (invoiced.rows.length > 0) {
        throw new ApiError(
          httpStatus.CONFLICT,
          "This quotation has already been invoiced directly, so it cannot become a project!",
        );
      }

      relationId = quote.relation_id;
      inquiryId = quote.inquiry_id;
      serviceTypeId = quote.service_type_id;
      title = title ?? quote.title;
      if (quote.street) {
        address = {
          street: quote.street,
          house_number: quote.house_number,
          postcode: quote.postcode,
          city: quote.city,
          country: quote.country,
        };
      }
      contact = {
        name: contact.name ?? quote.recipient_name ?? null,
        email: contact.email ?? quote.recipient_email ?? null,
        phone: contact.phone,
      };

      const lines = await client.query(
        `
          SELECT s.title AS section_title, l.catalogue_item_id, l.description,
                 l.quantity::float8 AS quantity, l.unit,
                 l.unit_price::float8 AS unit_price, l.cost_price::float8 AS cost_price,
                 l.vat_code, l.vat_rate::float8 AS vat_rate, l.vat_reverse_charge
          FROM quote_lines l
          JOIN quote_sections s ON s.id = l.section_id
          WHERE l.quote_id = $1::uuid
          ORDER BY s.sort_order ASC, l.sort_order ASC
        `,
        [quote.id],
      );
      quoteSections = groupBySection(lines.rows).map((s) => ({
        title: s.title,
        lines: s.lines,
      }));
    } else {
      relationId = input.relation_id as string;
      assertUuid(relationId, "relation id");
      const relation = await client.query(
        `
          SELECT r.id, r.type, r.name, r.email, r.phone, r.is_active,
                 pc.name AS contact_name, pc.email AS contact_email, pc.phone AS contact_phone
          FROM relations r
          LEFT JOIN relation_contacts pc ON pc.relation_id = r.id AND pc.is_primary
          WHERE r.id = $1::uuid
        `,
        [relationId],
      );
      if (relation.rows.length === 0) {
        throw new ApiError(httpStatus.NOT_FOUND, "Relation not found!");
      }
      const r = relation.rows[0];
      if (!r.is_active) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          "This relation is deactivated!",
        );
      }
      if (!customerTypes.includes(r.type)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          "A project can only be made for a customer!",
        );
      }
      contact = {
        name: contact.name ?? r.contact_name ?? r.name,
        email: contact.email ?? r.contact_email ?? r.email ?? null,
        phone: contact.phone ?? r.contact_phone ?? r.phone ?? null,
      };
    }

    if (input.service_type !== undefined) {
      serviceTypeId = await resolveServiceTypeId(input.service_type, client);
    }
    if (input.address !== undefined) {
      address = input.address ? normalizeAddress(input.address) : null;
    }

    if (!title) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Title is required!");
    }

    // Dates may come from the request only; the end cannot be before the start
    const plannedStart = input.planned_start ?? null;
    const plannedEnd = input.planned_end ?? null;

    const preparedManual = input.sections
      ? await QuoteService.prepareSections(
          input.sections as IQuoteSectionInput[],
        )
      : null;

    const number = await SettingsService.nextDocumentNumber("project", client);
    const statusId = await getStartStatus(client);

    const created = await client.query(
      `
        INSERT INTO projects (
          number, relation_id, quote_id, inquiry_id, service_type_id, status_id, title, description,
          street, house_number, postcode, city, country,
          planned_start, planned_end, contact_name, contact_email, contact_phone,
          project_manager_id, internal_notes, created_by
        ) VALUES (
          $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8,
          $9, $10, $11, $12, COALESCE($13, 'NL'),
          $14::date, $15::date, $16, $17, $18,
          $19::uuid, $20, $21::uuid
        ) RETURNING id
      `,
      [
        number,
        relationId,
        quote?.id ?? null,
        inquiryId,
        serviceTypeId,
        statusId,
        title,
        clean(input.description),
        address?.street ?? null,
        address?.house_number ?? null,
        address?.postcode ?? null,
        address?.city ?? null,
        address?.country ?? null,
        plannedStart,
        plannedEnd,
        contact.name,
        contact.email,
        contact.phone,
        input.project_manager_id ?? null,
        clean(input.internal_notes),
        actorId,
      ],
    );
    const id = created.rows[0].id as string;
    // Every project has its chat: a customer channel and an internal one
    await ensureChannels(id, client);

    const budgetSections = quoteSections ?? preparedManual;
    if (budgetSections) {
      await insertSections(client, id, "BUDGET", budgetSections, actorId);
      await recomputeTotals(client, id);
    }

    await logProjectEvent(
      client,
      { id, relation_id: relationId },
      "PROJECT_CREATED",
      `Project ${number} created`,
      actorId,
      {
        metadata: {
          quote_id: quote?.id ?? null,
          quote_number: quote?.number ?? null,
        },
      },
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "CREATE",
        entity_type: "project",
        entity_id: id,
        changes: { number, quote_id: quote?.id ?? null },
      },
      client,
    );

    return id;
  }).catch((error: any) => {
    // Two requests created a project from the same quotation at the same moment
    if (
      error?.code === "23505" &&
      String(error?.constraint ?? "").includes("uq_projects_quote")
    ) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "This quotation already has a project!",
      );
    }
    if (
      error?.code === "23514" &&
      String(error?.constraint ?? "").includes("planned_dates")
    ) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "The end date cannot be before the start date!",
      );
    }
    throw error;
  });

  // The project's chat shows up in the lists of the people who may see it, live
  await announceProject(projectId);
  return getProjectById(projectId);
};

const updateProject = async (
  id: string,
  payload: IUpdateProject,
  actorId: string,
) => {
  if (payload.project_manager_id)
    await assertManager(payload.project_manager_id);

  await transaction(async (client) => {
    const project = await lockProject(client, id);

    const data: Record<string, any> = {};
    if (payload.title !== undefined) {
      data.title = clean(payload.title);
      if (!data.title)
        throw new ApiError(httpStatus.BAD_REQUEST, "A project needs a title!");
    }
    if (payload.description !== undefined)
      data.description = clean(payload.description);
    if (payload.service_type !== undefined) {
      data.service_type_id = await resolveServiceTypeId(
        payload.service_type,
        client,
      );
    }
    if (payload.address !== undefined) {
      const a = payload.address ? normalizeAddress(payload.address) : null;
      data.street = a?.street ?? null;
      data.house_number = a?.house_number ?? null;
      data.postcode = a?.postcode ?? null;
      data.city = a?.city ?? null;
      data.country = a?.country ?? "NL";
    }
    if (payload.planned_start !== undefined)
      data.planned_start = payload.planned_start;
    if (payload.planned_end !== undefined)
      data.planned_end = payload.planned_end;
    if (payload.contact_name !== undefined)
      data.contact_name = clean(payload.contact_name);
    if (payload.contact_email !== undefined)
      data.contact_email = clean(payload.contact_email)?.toLowerCase() ?? null;
    if (payload.contact_phone !== undefined)
      data.contact_phone = clean(payload.contact_phone);
    if (payload.project_manager_id !== undefined)
      data.project_manager_id = payload.project_manager_id;
    if (payload.internal_notes !== undefined)
      data.internal_notes = clean(payload.internal_notes);

    if (Object.keys(data).length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
    }

    // The two dates are checked together, also when only one of them is sent
    if (data.planned_start !== undefined || data.planned_end !== undefined) {
      const current = await client.query(
        `SELECT to_char(planned_start, 'YYYY-MM-DD') AS s, to_char(planned_end, 'YYYY-MM-DD') AS e FROM projects WHERE id = $1::uuid`,
        [id],
      );
      const start =
        data.planned_start !== undefined
          ? data.planned_start
          : current.rows[0].s;
      const end =
        data.planned_end !== undefined ? data.planned_end : current.rows[0].e;
      if (start && end && end < start) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          "The end date cannot be before the start date!",
        );
      }
    }

    const casts: Record<string, string> = {
      service_type_id: "::uuid",
      project_manager_id: "::uuid",
      planned_start: "::date",
      planned_end: "::date",
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
      `UPDATE projects SET ${updates.join(", ")} WHERE id = $${n}::uuid`,
      values,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "project",
        entity_id: id,
        changes: { fields: Object.keys(data) },
      },
      client,
    );
    void project;
  });

  return getProjectById(id);
};

// Only a project that has not started: no work planned, no files, no additional work
const deleteProject = async (id: string, actorId: string) => {
  await transaction(async (client) => {
    const project = await lockProject(client, id);

    const status = await client.query(
      `SELECT kind FROM project_statuses WHERE id = $1::uuid`,
      [project.status_id],
    );
    if (status.rows[0]?.kind !== "NEW") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "Only a project that has not started can be deleted!",
      );
    }

    const used = await client.query(
      `
        SELECT
          (SELECT COUNT(*)::int FROM appointments WHERE project_id = $1::uuid) AS appointments,
          (SELECT COUNT(*)::int FROM project_files WHERE project_id = $1::uuid) AS files,
          (SELECT COUNT(*)::int FROM work_orders WHERE project_id = $1::uuid) AS work_orders,
          (SELECT COUNT(*)::int FROM time_entries WHERE project_id = $1::uuid) AS hours,
          (SELECT COUNT(*)::int FROM invoices WHERE project_id = $1::uuid) AS invoices,
          (SELECT COUNT(*)::int FROM purchase_orders WHERE project_id = $1::uuid) AS purchase_orders,
          (SELECT COUNT(*)::int FROM supplier_invoices WHERE project_id = $1::uuid) AS supplier_invoices,
          (SELECT COUNT(*)::int FROM subcontract_assignments WHERE project_id = $1::uuid) AS assignments,
          (SELECT COUNT(*)::int FROM project_lines WHERE project_id = $1::uuid AND kind = 'ADDITIONAL') AS additional
      `,
      [id],
    );
    const u = used.rows[0];
    if (
      u.appointments > 0 ||
      u.files > 0 ||
      u.additional > 0 ||
      u.work_orders > 0 ||
      u.hours > 0 ||
      u.invoices > 0 ||
      u.purchase_orders > 0 ||
      u.supplier_invoices > 0 ||
      u.assignments > 0
    ) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "This project already has appointments, work orders, hours, invoices, purchases, subcontracting, files or additional work and cannot be deleted!",
      );
    }

    await client.query(`DELETE FROM projects WHERE id = $1::uuid`, [id]);
    await logProjectEvent(
      client,
      { id, relation_id: project.relation_id },
      "PROJECT_DELETED",
      `Project ${project.number} deleted`,
      actorId,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "DELETE",
        entity_type: "project",
        entity_id: id,
        changes: { number: project.number },
      },
      client,
    );
  });
};

// ---------------------------------------------------------------------------
// Status (FR-PRJ-02)
// ---------------------------------------------------------------------------

const changeStatus = async (
  id: string,
  payload: IChangeProjectStatus,
  actorId: string,
) => {
  const target = await getStatusByKey(payload.status);

  await transaction(async (client) => {
    const project = await lockProject(client, id);

    if (project.status_id === target.id) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "The project already has this status!",
      );
    }

    const closing = target.kind === "CLOSED";
    await client.query(
      `
        UPDATE projects
        SET status_id = $2::uuid,
            closed_at = CASE WHEN $3::boolean THEN COALESCE(closed_at, CURRENT_TIMESTAMP) ELSE NULL END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [id, target.id, closing],
    );

    const from = await client.query(
      `SELECT key, label_en FROM project_statuses WHERE id = $1::uuid`,
      [project.status_id],
    );
    await logProjectEvent(
      client,
      { id, relation_id: project.relation_id },
      closing
        ? "PROJECT_CLOSED"
        : project.closed_at
          ? "PROJECT_REOPENED"
          : "PROJECT_STATUS_CHANGED",
      `Project ${project.number}: ${from.rows[0]?.label_en ?? "?"} → ${target.label_en}`,
      actorId,
      {
        description: clean(payload.note),
        metadata: { from: from.rows[0]?.key ?? null, to: target.key },
      },
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "STATUS_CHANGE",
        entity_type: "project",
        entity_id: id,
        changes: { from: from.rows[0]?.key ?? null, to: target.key },
      },
      client,
    );
  });

  return getProjectById(id);
};

// ---------------------------------------------------------------------------
// Budget and additional work (FR-PRJ-04, FR-PRJ-05)
// ---------------------------------------------------------------------------

// Replaces the whole budget (the same sections format as a quotation)
const setBudget = async (
  id: string,
  sections: IQuoteSectionInput[],
  actorId: string,
) => {
  const prepared = await QuoteService.prepareSections(sections);

  await transaction(async (client) => {
    const project = await lockProject(client, id);
    assertOpen(project);

    // Once (part of) the budget is on an invoice it is no longer ours to rewrite
    const invoiced = await client.query(
      `
        SELECT
          (SELECT COUNT(*)::int FROM project_lines WHERE project_id = $1::uuid AND kind = 'BUDGET' AND invoice_id IS NOT NULL) AS lines,
          (SELECT COUNT(*)::int FROM invoices WHERE project_id = $1::uuid AND kind = 'INSTALMENT' AND payment_status IS DISTINCT FROM 'CREDITED') AS instalments
      `,
      [id],
    );
    if (invoiced.rows[0].lines > 0 || invoiced.rows[0].instalments > 0) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "The budget has been invoiced (or is invoiced in instalments) and can no longer be replaced!",
      );
    }

    await client.query(
      `DELETE FROM project_lines WHERE project_id = $1::uuid AND kind = 'BUDGET'`,
      [id],
    );
    await insertSections(client, id, "BUDGET", prepared, actorId);
    await recomputeTotals(client, id);

    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "project",
        entity_id: id,
        changes: {
          budget_lines: prepared.reduce((n, s) => n + s.lines.length, 0),
        },
      },
      client,
    );
  });

  return getProjectById(id);
};

const addAdditionalWork = async (
  id: string,
  input: IAdditionalWorkInput,
  actorId: string,
) => {
  const [prepared] = await QuoteService.prepareSections([
    { title: null, lines: [input] },
  ]);
  const line = prepared.lines[0];

  const lineId = await transaction(async (client) => {
    const project = await lockProject(client, id);
    assertOpen(project);

    const order = await nextSortOrder(client, id, "ADDITIONAL");
    const newId = await insertLine(
      client,
      id,
      "ADDITIONAL",
      clean(input.section_title),
      order,
      line,
      actorId,
    );
    await recomputeTotals(client, id);

    await logProjectEvent(
      client,
      { id, relation_id: project.relation_id },
      "PROJECT_ADDITIONAL_WORK",
      `Additional work added to project ${project.number}`,
      actorId,
      { description: line.description, metadata: { line_id: newId } },
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "CREATE",
        entity_type: "project_line",
        entity_id: newId,
        changes: { project_id: id, description: line.description },
      },
      client,
    );
    return newId;
  });

  const detail = await getProjectById(id);
  return {
    line: detail.additional_work.find((l: any) => l.id === lineId),
    project: detail,
  };
};

const updateAdditionalWork = async (
  id: string,
  lineId: string,
  payload: Partial<IAdditionalWorkInput>,
  actorId: string,
) => {
  assertUuid(lineId, "line id");

  await transaction(async (client) => {
    const project = await lockProject(client, id);
    assertOpen(project);

    const found = await client.query(
      `SELECT ${lineColumns} FROM project_lines WHERE id = $1::uuid AND project_id = $2::uuid AND kind = 'ADDITIONAL' FOR UPDATE`,
      [lineId, id],
    );
    if (found.rows.length === 0) {
      throw new ApiError(
        httpStatus.NOT_FOUND,
        "Additional work line not found!",
      );
    }
    const current = found.rows[0];
    const claimed = await client.query(
      `SELECT invoice_id FROM project_lines WHERE id = $1::uuid`,
      [lineId],
    );
    if (claimed.rows[0].invoice_id) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "This additional work is on an invoice and can no longer be changed!",
      );
    }

    // Re-run the shared line checks on the merged line (VAT code, amounts, units)
    const [prepared] = await QuoteService.prepareSections([
      {
        title: null,
        lines: [
          {
            catalogue_item_id: current.catalogue_item_id ?? undefined,
            description: payload.description ?? current.description,
            quantity: payload.quantity ?? current.quantity,
            unit: (payload.unit ?? current.unit) as any,
            unit_price: payload.unit_price ?? current.unit_price,
            cost_price: payload.cost_price ?? current.cost_price,
            vat_code: payload.vat_code ?? current.vat_code,
          },
        ],
      },
    ]);
    const line = prepared.lines[0];
    const calc = calculateLine(line);
    const sectionTitle =
      payload.section_title !== undefined
        ? clean(payload.section_title)
        : current.section_title;

    await client.query(
      `
        UPDATE project_lines SET
          section_title = $2, description = $3, quantity = $4, unit = $5, unit_price = $6, cost_price = $7,
          vat_code = $8, vat_rate = $9, vat_reverse_charge = $10, line_total = $11, line_cost = $12
        WHERE id = $1::uuid
      `,
      [
        lineId,
        sectionTitle,
        line.description,
        line.quantity,
        line.unit,
        line.unit_price,
        line.cost_price,
        line.vat_code,
        line.vat_rate,
        line.vat_reverse_charge,
        fromCents(calc.totalCents),
        fromCents(calc.costCents),
      ],
    );
    await recomputeTotals(client, id);
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "project_line",
        entity_id: lineId,
        changes: { project_id: id, fields: Object.keys(payload) },
      },
      client,
    );
  });

  return getProjectById(id);
};

const deleteAdditionalWork = async (
  id: string,
  lineId: string,
  actorId: string,
) => {
  assertUuid(lineId, "line id");

  await transaction(async (client) => {
    const project = await lockProject(client, id);
    assertOpen(project);

    const claimed = await client.query(
      `SELECT invoice_id FROM project_lines WHERE id = $1::uuid AND project_id = $2::uuid AND kind = 'ADDITIONAL' FOR UPDATE`,
      [lineId, id],
    );
    if (claimed.rows.length > 0 && claimed.rows[0].invoice_id) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "This additional work is on an invoice and can no longer be removed!",
      );
    }
    const removed = await client.query(
      `DELETE FROM project_lines WHERE id = $1::uuid AND project_id = $2::uuid AND kind = 'ADDITIONAL' RETURNING description`,
      [lineId, id],
    );
    if (removed.rows.length === 0) {
      throw new ApiError(
        httpStatus.NOT_FOUND,
        "Additional work line not found!",
      );
    }
    await recomputeTotals(client, id);
    await logAudit(
      {
        actor_id: actorId,
        action: "DELETE",
        entity_type: "project_line",
        entity_id: lineId,
        changes: { project_id: id, description: removed.rows[0].description },
      },
      client,
    );
  });

  return getProjectById(id);
};

// ---------------------------------------------------------------------------
// Financial overview (FR-PRJ-03)
// ---------------------------------------------------------------------------

// Budget, additional work and approved hours are real. Invoices, purchases and subcontracting
// come from their own modules; `sources` says where each amount comes from.
const getFinancials = async (id: string) => {
  const project = await getProjectById(id);
  const hours = await query(
    `
      SELECT COALESCE(SUM(minutes), 0)::int AS total,
             COALESCE(SUM(minutes) FILTER (WHERE is_billable), 0)::int AS billable,
             COALESCE(SUM(minutes) FILTER (WHERE status = 'APPROVED'), 0)::int AS approved,
             COALESCE(SUM(cost_cents) FILTER (WHERE status = 'APPROVED'), 0)::float8 AS cost_cents,
             COALESCE(SUM(sales_cents) FILTER (WHERE status = 'APPROVED' AND is_billable), 0)::float8 AS sales_cents
      FROM time_entries
      WHERE project_id = $1::uuid
    `,
    [id],
  );

  // Invoiced, paid and open, from the issued invoices (credit notes count as negative invoiced)
  const money = await query(
    `
      SELECT COALESCE(SUM(total_excl_vat), 0)::float8 AS excl,
             COALESCE(SUM(total_incl_vat), 0)::float8 AS incl,
             COALESCE(SUM(paid_amount) FILTER (WHERE kind <> 'CREDIT_NOTE'), 0)::float8 AS paid,
             COALESCE(SUM(GREATEST(0, total_incl_vat - credited_amount - paid_amount)) FILTER (WHERE kind <> 'CREDIT_NOTE'), 0)::float8 AS outstanding
      FROM invoices WHERE project_id = $1::uuid AND status = 'ISSUED'
    `,
    [id],
  );
  const inv = money.rows[0];

  // What the project costs in purchases (FR-PUR-05): the suppliers' invoices that were approved
  // (or paid) count as real cost; received ones still wait for approval; open orders are committed
  const buying = await query(
    `
      SELECT
        (SELECT COALESCE(SUM(amount_excl_vat) FILTER (WHERE status IN ('APPROVED', 'PAID')), 0)::float8
         FROM supplier_invoices WHERE project_id = $1::uuid AND subcontract_assignment_id IS NULL) AS actual,
        (SELECT COALESCE(SUM(amount_excl_vat) FILTER (WHERE status = 'RECEIVED'), 0)::float8
         FROM supplier_invoices WHERE project_id = $1::uuid AND subcontract_assignment_id IS NULL) AS pending,
        (SELECT COALESCE(SUM(GREATEST(0, po.total_excl_vat - COALESCE(
                  (SELECT SUM(si.amount_excl_vat) FROM supplier_invoices si WHERE si.purchase_order_id = po.id AND si.status <> 'VOID'), 0))), 0)::float8
         FROM purchase_orders po WHERE po.project_id = $1::uuid AND po.status IN ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED')) AS committed
    `,
    [id],
  );
  const purchases = buying.rows[0];

  // Subcontracting (FR-SUB-04): the subcontractors' invoices that were approved (or paid) are
  // the real cost; received ones wait for approval; the agreed price of a confirmed assignment
  // that has not been invoiced yet is committed
  const subcontracting = await query(
    `
      SELECT
        (SELECT COALESCE(SUM(amount_excl_vat) FILTER (WHERE status IN ('APPROVED', 'PAID')), 0)::float8
         FROM supplier_invoices WHERE project_id = $1::uuid AND subcontract_assignment_id IS NOT NULL) AS actual,
        (SELECT COALESCE(SUM(amount_excl_vat) FILTER (WHERE status = 'RECEIVED'), 0)::float8
         FROM supplier_invoices WHERE project_id = $1::uuid AND subcontract_assignment_id IS NOT NULL) AS pending,
        (SELECT COALESCE(SUM(GREATEST(0, sa.agreed_price_excl_vat - COALESCE(
                  (SELECT SUM(si.amount_excl_vat) FROM supplier_invoices si WHERE si.subcontract_assignment_id = sa.id AND si.status <> 'VOID'), 0))), 0)::float8
         FROM subcontract_assignments sa WHERE sa.project_id = $1::uuid AND sa.status IN ('CONFIRMED', 'COMPLETED', 'INVOICED')) AS committed
    `,
    [id],
  );
  const sub = subcontracting.rows[0];
  const hoursCost = hours.rows[0].cost_cents / 100;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const quotedExcl = project.total_calculation.total_excl_vat;
  const quotedCost = project.total_calculation.cost_total;
  const margin = Math.round((quotedExcl - quotedCost) * 100) / 100;

  return {
    project: { id: project.id, number: project.number, title: project.title },
    budget: project.budget_calculation,
    additional_work: project.additional_calculation,
    total_quoted: {
      excl_vat: project.total_calculation.total_excl_vat,
      vat: project.total_calculation.total_vat,
      incl_vat: project.total_calculation.total_incl_vat,
    },
    expected_cost: quotedCost,
    expected_margin: margin,
    expected_margin_percent: marginPercent(
      toCents(margin),
      toCents(quotedExcl),
    ),
    invoiced: {
      excl_vat: Math.round(inv.excl * 100) / 100,
      incl_vat: Math.round(inv.incl * 100) / 100,
    },
    paid: Math.round(inv.paid * 100) / 100,
    outstanding: Math.round(inv.outstanding * 100) / 100,
    // Hours recorded on work orders (FR-WO-05). They have no cost rate yet (comes with Uren), so no cost.
    logged_hours: {
      total_minutes: hours.rows[0].total,
      billable_minutes: hours.rows[0].billable,
      total_hours: Math.round((hours.rows[0].total / 60) * 100) / 100,
      billable_hours: Math.round((hours.rows[0].billable / 60) * 100) / 100,
      // Only approved hours count towards the cost; the rest still waits for the office's review
      approved_minutes: hours.rows[0].approved,
      approved_hours: Math.round((hours.rows[0].approved / 60) * 100) / 100,
      pending_minutes: hours.rows[0].total - hours.rows[0].approved,
      pending_hours:
        Math.round(
          ((hours.rows[0].total - hours.rows[0].approved) / 60) * 100,
        ) / 100,
      // Selling value of the approved billable hours (what can go on an invoice)
      approved_sales_value: hours.rows[0].sales_cents / 100,
    },
    // Hours at cost rate come from approved hours (Uren); purchases and subcontracting arrive with their modules
    actual_costs: {
      hours: hoursCost,
      purchases: r2(purchases.actual),
      subcontracting: r2(sub.actual),
      total: r2(hoursCost + purchases.actual + sub.actual),
    },
    // Not yet cost, but coming: supplier invoices waiting for approval and the part of the open
    // purchase orders that has not been invoiced yet
    purchasing: {
      invoices_awaiting_approval_excl_vat: r2(purchases.pending),
      committed_excl_vat: r2(purchases.committed),
    },
    subcontracting: {
      invoices_awaiting_approval_excl_vat: r2(sub.pending),
      committed_excl_vat: r2(sub.committed),
    },
    sources: {
      invoices: "INVOICES",
      hours: "APPROVED_HOURS",
      purchases: "SUPPLIER_INVOICES",
      subcontracting: "SUBCONTRACTOR_INVOICES",
    },
  };
};

// ---------------------------------------------------------------------------
// Files (FR-PRJ-06)
// ---------------------------------------------------------------------------

const toBool = (value: any) =>
  value === true || value === "true" || value === "1" || value === 1;

const addFiles = async (
  projectId: string,
  files: any[],
  fields: Record<string, any>,
  actorId: string | null,
  options: {
    workOrderId?: string;
    assignmentId?: string;
    chatMessageId?: string;
    defaultFolder?: string;
  } = {},
) => {
  assertUuid(projectId, "project id");
  if (!files || files.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No files uploaded!");
  }

  const folder = String(
    fields.folder ?? options.defaultFolder ?? "GENERAL",
  ).toUpperCase();
  if (!(projectFolders as readonly string[]).includes(folder)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Folder should be BEFORE, DURING, AFTER or GENERAL!",
    );
  }
  const caption = clean(fields.caption);
  if (caption && caption.length > 255) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The caption is too long!");
  }

  const existing = await query(
    `SELECT (SELECT COUNT(*)::int FROM project_files f WHERE f.project_id = p.id) AS file_count
     FROM projects p WHERE p.id = $1::uuid`,
    [projectId],
  );
  if (existing.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }
  if (existing.rows[0].file_count + files.length > MAX_FILES_PER_PROJECT) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `A project can have at most ${MAX_FILES_PER_PROJECT} files!`,
    );
  }

  // Check every file before uploading any, so a bad one rejects the whole batch
  const checked = files.map((file) => {
    const name = path
      .basename(String(file.originalname ?? "file"))
      .replace(/[\u0000-\u001f]/g, "")
      .slice(0, 255);
    if (!file.buffer || file.buffer.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${name}: the file is empty!`);
    }
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${name}: the file is larger than 10 MB!`,
      );
    }
    const type = detectFileType(file.buffer);
    if (!type) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${name}: only JPEG, PNG, WebP and PDF files are allowed!`,
      );
    }
    return { file, name, mime: type.mime };
  });

  const saved: any[] = [];
  for (const { file, name, mime } of checked) {
    let uploaded: { Location: string; Key: string };
    try {
      uploaded = await S3Uploader.uploadToS3(file, `projects/${projectId}`);
    } catch (error) {
      throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, "File upload failed.");
    }

    const result = await query(
      `
        INSERT INTO project_files (
          project_id, folder, file_url, storage_key, file_name, mime_type, size_bytes, caption,
          share_with_customer, share_with_subcontractor, uploaded_by, work_order_id, subcontract_assignment_id, chat_message_id
        ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::uuid, $13::uuid, $14::uuid)
        RETURNING ${fileColumns}
      `,
      [
        projectId,
        folder,
        uploaded.Location,
        uploaded.Key,
        name,
        mime,
        file.buffer.length,
        caption,
        toBool(fields.share_with_customer),
        toBool(fields.share_with_subcontractor),
        actorId,
        options.workOrderId ?? null,
        options.assignmentId ?? null,
        options.chatMessageId ?? null,
      ],
    );
    saved.push(result.rows[0]);
  }

  return saved;
};

const getFiles = async (projectId: string, params: Record<string, any>) => {
  assertUuid(projectId, "project id");
  const exists = await query(`SELECT 1 FROM projects WHERE id = $1::uuid`, [
    projectId,
  ]);
  if (exists.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }

  const values: any[] = [projectId];
  let where = `project_id = $1::uuid`;
  if (params.folder) {
    const folder = String(params.folder).toUpperCase();
    if (!(projectFolders as readonly string[]).includes(folder)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Folder should be BEFORE, DURING, AFTER or GENERAL!",
      );
    }
    values.push(folder);
    where += ` AND folder = $2`;
  }
  const result = await query(
    `SELECT ${fileColumns} FROM project_files WHERE ${where} ORDER BY created_at ASC`,
    values,
  );
  return result.rows;
};

const updateFile = async (
  projectId: string,
  fileId: string,
  payload: {
    folder?: string;
    caption?: string | null;
    share_with_customer?: boolean;
    share_with_subcontractor?: boolean;
  },
  actorId: string,
) => {
  assertUuid(projectId, "project id");
  assertUuid(fileId, "file id");

  const data: Record<string, any> = {};
  if (payload.folder !== undefined) data.folder = payload.folder;
  if (payload.caption !== undefined) data.caption = clean(payload.caption);
  if (payload.share_with_customer !== undefined)
    data.share_with_customer = payload.share_with_customer;
  if (payload.share_with_subcontractor !== undefined)
    data.share_with_subcontractor = payload.share_with_subcontractor;

  const updates: string[] = [];
  const values: any[] = [];
  let n = 1;
  for (const [field, value] of Object.entries(data)) {
    updates.push(`${field} = $${n++}`);
    values.push(value);
  }
  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }
  values.push(fileId, projectId);

  const result = await query(
    `UPDATE project_files SET ${updates.join(", ")} WHERE id = $${n}::uuid AND project_id = $${n + 1}::uuid RETURNING ${fileColumns}`,
    values,
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "File not found!");
  }
  await logAudit({
    actor_id: actorId,
    action: "UPDATE",
    entity_type: "project_file",
    entity_id: fileId,
    changes: { project_id: projectId, fields: Object.keys(data) },
  });
  return result.rows[0];
};

const deleteFile = async (
  projectId: string,
  fileId: string,
  actorId: string,
) => {
  assertUuid(projectId, "project id");
  assertUuid(fileId, "file id");

  const result = await query(
    `DELETE FROM project_files WHERE id = $1::uuid AND project_id = $2::uuid RETURNING storage_key, file_name`,
    [fileId, projectId],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "File not found!");
  }
  await logAudit({
    actor_id: actorId,
    action: "DELETE",
    entity_type: "project_file",
    entity_id: fileId,
    changes: { project_id: projectId, file_name: result.rows[0].file_name },
  });

  // The record is gone either way; a storage hiccup only leaves an unused file behind
  try {
    await S3Uploader.deleteFromS3(result.rows[0].storage_key);
  } catch (error) {
    console.error(
      "❌ Could not delete file from storage:",
      result.rows[0].storage_key,
      error,
    );
  }
};

// ---------------------------------------------------------------------------
// Crew view (FR-PRJ-07): only the projects the user is planned on. No prices,
// no internal notes, no other records' ids.
// ---------------------------------------------------------------------------

const myScope = `
  EXISTS (
    SELECT 1 FROM appointments a
    JOIN appointment_assignees aa ON aa.appointment_id = a.id
    WHERE a.project_id = p.id AND aa.user_id = $1::uuid AND a.status <> 'CANCELLED'
  )
`;

const crewColumns = `
  p.id, p.number, p.title, p.description,
  p.street, p.house_number, p.postcode, p.city, p.country,
  to_char(p.planned_start, 'YYYY-MM-DD') AS planned_start,
  to_char(p.planned_end, 'YYYY-MM-DD') AS planned_end,
  p.contact_name, p.contact_phone,
  s.label_nl AS status_label_nl, s.label_en AS status_label_en, s.kind AS status_kind,
  r.name AS customer_name,
  CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object('key', st.key, 'label_nl', st.label_nl, 'label_en', st.label_en) END AS service_type
`;

const crewJoins = `
  JOIN project_statuses s ON s.id = p.status_id
  JOIN relations r ON r.id = p.relation_id
  LEFT JOIN service_types st ON st.id = p.service_type_id
`;

const getMyProjects = async (userId: string, params: Record<string, any>) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );

  const [result, count] = await Promise.all([
    query(
      `
        SELECT ${crewColumns}
        FROM projects p ${crewJoins}
        WHERE ${myScope} AND s.kind <> 'CLOSED'
        ORDER BY p.planned_start ASC NULLS LAST, p.created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [userId, limit, skip],
    ),
    query(
      `SELECT COUNT(*) AS total FROM projects p ${crewJoins} WHERE ${myScope} AND s.kind <> 'CLOSED'`,
      [userId],
    ),
  ]);

  const total = parseInt(count.rows[0].total);
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    meta: {
      page,
      limit,
      total,
      totalPage,
      hasNextPage: page < totalPage,
      hasPrevPage: page > 1,
    },
  };
};

const getMyProjectById = async (userId: string, id: string) => {
  assertUuid(id, "project id");

  const result = await query(
    `SELECT ${crewColumns} FROM projects p ${crewJoins} WHERE p.id = $2::uuid AND ${myScope}`,
    [userId, id],
  );
  // The same answer for "does not exist" and "not yours"
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }

  const [appointments, files, workOrders] = await Promise.all([
    query(
      `
        SELECT a.id, a.type, a.status, a.title, a.starts_at, a.ends_at, a.all_day, a.notes
        FROM appointments a
        JOIN appointment_assignees aa ON aa.appointment_id = a.id AND aa.user_id = $1::uuid
        WHERE a.project_id = $2::uuid AND a.status <> 'CANCELLED'
        ORDER BY a.starts_at ASC
      `,
      [userId, id],
    ),
    query(
      `SELECT id, folder, file_url, file_name, mime_type, caption FROM project_files WHERE project_id = $1::uuid ORDER BY created_at ASC`,
      [id],
    ),
    query(
      `
        SELECT w.id, w.number, w.title, w.status, w.planned_date::text AS planned_date
        FROM work_orders w JOIN work_order_assignees wa ON wa.work_order_id = w.id AND wa.user_id = $1::uuid
        WHERE w.project_id = $2::uuid
        ORDER BY w.planned_date ASC NULLS LAST, w.created_at ASC
      `,
      [userId, id],
    ),
  ]);

  return {
    ...result.rows[0],
    appointments: appointments.rows,
    files: files.rows,
    work_orders: workOrders.rows,
  };
};

// ---------------------------------------------------------------------------
// Used by the work order module
// ---------------------------------------------------------------------------

// The first started work order moves a project that is still "new" on to In uitvoering.
// Silent: it never moves a project backwards or reopens a closed one.
const moveToInProgressFromWorkOrder = async (
  client: any,
  projectId: string,
  actorId: string | null,
) => {
  const target = await client.query(
    `SELECT id, label_en FROM project_statuses WHERE key = 'in_uitvoering' AND is_active`,
  );
  if (target.rows.length === 0) return;

  const moved = await client.query(
    `
      UPDATE projects SET status_id = $2::uuid, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid AND closed_at IS NULL
        AND status_id IN (SELECT id FROM project_statuses WHERE kind = 'NEW')
      RETURNING id, number, relation_id
    `,
    [projectId, target.rows[0].id],
  );
  if (moved.rows.length === 0) return;

  await logProjectEvent(
    client,
    { id: projectId, relation_id: moved.rows[0].relation_id },
    "PROJECT_STATUS_CHANGED",
    `Project ${moved.rows[0].number}: started (first work order in progress)`,
    actorId,
    { metadata: { to: "in_uitvoering", via: "work_order" } },
  );
};

// Once the whole budget is on issued invoices the project counts as invoiced (Gefactureerd).
// Silent: only forwards, never for a closed project.
const moveToInvoicedFromInvoice = async (
  client: any,
  projectId: string,
  actorId: string | null,
) => {
  const target = await client.query(
    `SELECT id, sort_order FROM project_statuses WHERE key = 'gefactureerd' AND is_active`,
  );
  if (target.rows.length === 0) return;

  const moved = await client.query(
    `
      UPDATE projects SET status_id = $2::uuid, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid AND closed_at IS NULL
        AND status_id IN (SELECT id FROM project_statuses WHERE sort_order < $3)
      RETURNING id, number, relation_id
    `,
    [projectId, target.rows[0].id, target.rows[0].sort_order],
  );
  if (moved.rows.length === 0) return;

  await logProjectEvent(
    client,
    { id: projectId, relation_id: moved.rows[0].relation_id },
    "PROJECT_STATUS_CHANGED",
    `Project ${moved.rows[0].number}: invoiced (the whole budget is on invoices)`,
    actorId,
    { metadata: { to: "gefactureerd", via: "invoice" } },
  );
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const getHistory = async (id: string, params: Record<string, any>) => {
  assertUuid(id, "project id");

  const exists = await query(`SELECT 1 FROM projects WHERE id = $1::uuid`, [
    id,
  ]);
  if (exists.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }

  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );
  const scope = `t.entity_type = 'project' AND t.entity_id = $1::uuid`;

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
    query(`SELECT COUNT(*) AS total FROM relation_timeline t WHERE ${scope}`, [
      id,
    ]),
  ]);

  const total = parseInt(count.rows[0].total);
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    meta: {
      page,
      limit,
      total,
      totalPage,
      hasNextPage: page < totalPage,
      hasPrevPage: page > 1,
    },
  };
};

export const ProjectService = {
  createProject,
  getAllProjects,
  getProjectById,
  getSummary,
  updateProject,
  deleteProject,
  changeStatus,
  setBudget,
  addAdditionalWork,
  updateAdditionalWork,
  deleteAdditionalWork,
  getFinancials,
  addFiles,
  getFiles,
  updateFile,
  deleteFile,
  getMyProjects,
  getMyProjectById,
  getHistory,
  moveToInProgressFromWorkOrder,
  moveToInvoicedFromInvoice,
};
