import { enqueueSnelStart, withdrawFromSnelStart } from "../snelstart/snelstart.queue";
import path from "path";
import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { buildCsv, csvAmount, csvDelimiter } from "../../utils/csv";
import { amsterdamToday, isValidDay } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { detectFileType } from "../../utils/fileType";
import { formatMoney } from "../../utils/formatters";
import { toCents } from "../../utils/money";
import { createZip } from "../../utils/zip";
import { SettingsService } from "../settings/settings.service";
import { lockAssignment, logAssignmentEvent, syncAssignmentInvoiced } from "../subcontracting/subcontracting.shared";
import {
  IActor,
  ICreateSupplierInvoice,
  IPaySupplierInvoice,
  ISupplierInvoiceFields,
  IUpdateSupplierInvoice,
  supplierInvoiceStatuses,
} from "./purchasing.interface";
import { clean, loadSupplier, logPurchasingEvent, round2, run, todaySql } from "./purchasing.shared";

// Inkoop, part 2 (SRS 4.12): the suppliers' invoices. They are recorded with the document
// attached (FR-PUR-03), checked and approved (Ontvangen -> Goedgekeurd -> Betaald, FR-PUR-04),
// counted as project cost once approved (FR-PUR-05) and exported per period (FR-PUR-06).
// They are financial records: never deleted, a mistake is voided.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXPORT_DAYS = 366;
const MAX_EXPORT_FILES = 500;

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

const extensions: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const overdueSql = `(si.status IN ('RECEIVED', 'APPROVED') AND si.due_date < ${todaySql})`;

const columns = `
  si.id, si.invoice_number, to_char(si.invoice_date, 'YYYY-MM-DD') AS invoice_date,
  to_char(si.due_date, 'YYYY-MM-DD') AS due_date,
  si.amount_excl_vat::float8 AS amount_excl_vat, si.vat_amount::float8 AS vat_amount, si.amount_incl_vat::float8 AS amount_incl_vat,
  si.vat_code, si.status, si.description, si.internal_notes,
  (si.file_data IS NOT NULL) AS has_file, si.file_name, si.file_mime, si.file_size,
  si.received_at, ru.name AS recorded_by_name, si.recorded_by, au.name AS approved_by_name, si.approved_at,
  to_char(si.paid_at, 'YYYY-MM-DD') AS paid_at, si.payment_reference, si.voided_at, si.void_reason,
  si.created_at AS "createdAt", si.updated_at AS "updatedAt",
  ${overdueSql} AS is_overdue,
  json_build_object('id', s.id, 'name', s.name) AS supplier,
  CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'number', p.number, 'title', p.title) END AS project,
  CASE WHEN po.id IS NULL THEN NULL ELSE json_build_object('id', po.id, 'number', po.number, 'total_excl_vat', po.total_excl_vat::float8) END AS purchase_order,
  CASE WHEN sa.id IS NULL THEN NULL ELSE json_build_object('id', sa.id, 'number', sa.number, 'title', sa.title, 'agreed_price_excl_vat', sa.agreed_price_excl_vat::float8) END AS subcontract_assignment
`;

const joins = `
  JOIN relations s ON s.id = si.supplier_id
  LEFT JOIN projects p ON p.id = si.project_id
  LEFT JOIN purchase_orders po ON po.id = si.purchase_order_id
  LEFT JOIN subcontract_assignments sa ON sa.id = si.subcontract_assignment_id
  LEFT JOIN users ru ON ru.id = si.recorded_by
  LEFT JOIN users au ON au.id = si.approved_by
`;

const getSupplierInvoiceById = async (id: string, client?: any) => {
  assertUuid(id, "supplier invoice id");
  const q = run(client);
  const result = await q(`SELECT ${columns} FROM supplier_invoices si ${joins} WHERE si.id = $1::uuid`, [id]);
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Supplier invoice not found!");
  }
  const inv = result.rows[0];

  // Invoiced against the order so far: a warning when it is more than was ordered
  let overOrder = false;
  if (inv.purchase_order) {
    const sum = await q(
      `SELECT COALESCE(SUM(amount_excl_vat), 0)::float8 AS total FROM supplier_invoices WHERE purchase_order_id = $1::uuid AND status <> 'VOID'`,
      [inv.purchase_order.id],
    );
    overOrder = toCents(sum.rows[0].total) > toCents(inv.purchase_order.total_excl_vat);
  }

  // Invoiced for the assignment so far: a warning when it is more than the agreed price
  let overAgreed = false;
  if (inv.subcontract_assignment) {
    const sum = await q(
      `SELECT COALESCE(SUM(amount_excl_vat), 0)::float8 AS total FROM supplier_invoices WHERE subcontract_assignment_id = $1::uuid AND status <> 'VOID'`,
      [inv.subcontract_assignment.id],
    );
    overAgreed = toCents(sum.rows[0].total) > toCents(inv.subcontract_assignment.agreed_price_excl_vat);
  }

  return {
    ...inv,
    over_order_amount: overOrder,
    over_agreed_price: overAgreed,
    can_edit: inv.status === "RECEIVED",
    can_approve: inv.status === "RECEIVED" && inv.has_file,
    can_pay: inv.status === "APPROVED",
    can_void: inv.status === "RECEIVED" || inv.status === "APPROVED",
  };
};

const getAllSupplierInvoices = async (params: Record<string, any>) => {
  const { page, limit, skip, sortBy, sortOrder } = paginationHelper.calculatePagination(params as any);

  const sortable: Record<string, string> = {
    created_at: "si.created_at",
    invoice_date: "si.invoice_date",
    due_date: "si.due_date",
    total: "si.amount_incl_vat",
    supplier: "LOWER(s.name)",
    invoice_number: "LOWER(si.invoice_number)",
  };
  const orderColumn = sortable[sortBy] ?? "si.created_at";
  const orderDirection = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  const conditions: string[] = [];
  const values: any[] = [];
  let n = 1;

  if (params.searchTerm) {
    const term = String(Array.isArray(params.searchTerm) ? params.searchTerm[0] : params.searchTerm)
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(`(si.invoice_number ILIKE $${n} OR s.name ILIKE $${n} OR si.description ILIKE $${n} OR p.number ILIKE $${n} OR po.number ILIKE $${n})`);
    values.push(`%${term}%`);
    n++;
  }
  if (params.status) {
    const statuses = asList(params.status).map((s) => s.toUpperCase());
    if (statuses.some((s) => !(supplierInvoiceStatuses as readonly string[]).includes(s))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Status should be RECEIVED, APPROVED, PAID or VOID!");
    }
    conditions.push(`si.status = ANY($${n++}::"SupplierInvoiceStatus"[])`);
    values.push(statuses);
  }
  for (const [param, column, label] of [
    ["supplier_id", "si.supplier_id", "supplier id"],
    ["project_id", "si.project_id", "project id"],
    ["purchase_order_id", "si.purchase_order_id", "purchase order id"],
    ["subcontract_assignment_id", "si.subcontract_assignment_id", "assignment id"],
  ] as const) {
    if (params[param]) {
      assertUuid(String(params[param]), label);
      conditions.push(`${column} = $${n++}::uuid`);
      values.push(String(params[param]));
    }
  }
  if (String(params.subcontracted) === "true") conditions.push(`si.subcontract_assignment_id IS NOT NULL`);
  if (String(params.subcontracted) === "false") conditions.push(`si.subcontract_assignment_id IS NULL`);
  if (String(params.overdue) === "true") conditions.push(overdueSql);
  if (String(params.no_file) === "true") conditions.push(`si.file_data IS NULL AND si.status <> 'VOID'`);
  for (const [param, column, operator] of [
    ["invoice_from", "si.invoice_date", ">="],
    ["invoice_to", "si.invoice_date", "<="],
    ["due_from", "si.due_date", ">="],
    ["due_to", "si.due_date", "<="],
  ] as const) {
    if (params[param]) {
      conditions.push(`${column} ${operator} $${n++}::date`);
      values.push(assertDay(params[param], param));
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `FROM supplier_invoices si ${joins} ${where}`;

  const [result, totals] = await Promise.all([
    query(
      `
        SELECT ${columns}
        ${from}
        ORDER BY ${orderColumn} ${orderDirection} NULLS LAST, si.id ASC
        LIMIT $${n} OFFSET $${n + 1}
      `,
      [...values, limit, skip],
    ),
    query(
      `
        SELECT COUNT(*)::int AS total,
               COALESCE(SUM(si.amount_excl_vat) FILTER (WHERE si.status <> 'VOID'), 0)::float8 AS excl,
               COALESCE(SUM(si.amount_incl_vat) FILTER (WHERE si.status <> 'VOID'), 0)::float8 AS incl,
               COALESCE(SUM(si.amount_incl_vat) FILTER (WHERE si.status IN ('RECEIVED', 'APPROVED')), 0)::float8 AS to_pay
        ${from}
      `,
      values,
    ),
  ]);

  const total = totals.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    totals: { invoices: total, amount_excl_vat: round2(totals.rows[0].excl), amount_incl_vat: round2(totals.rows[0].incl), still_to_pay: round2(totals.rows[0].to_pay) },
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

// ---------------------------------------------------------------------------
// Recording (FR-PUR-03)
// ---------------------------------------------------------------------------

// The checks every recorded invoice goes through, on create and on edit
const validateFields = async (
  client: any,
  supplierId: string,
  f: ISupplierInvoiceFields,
  assignmentId: string | null = null,
  isNew = false,
) => {
  const today = amsterdamToday();
  if (f.invoice_date > today) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The invoice date cannot be in the future!");
  }
  if (f.due_date && f.due_date < f.invoice_date) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The due date cannot be before the invoice date!");
  }

  // The supplier's own VAT arithmetic: excl + VAT = incl, to the cent
  if (toCents(f.amount_excl_vat) + toCents(f.vat_amount) !== toCents(f.amount_incl_vat)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The amounts do not add up: excl. VAT + VAT must equal incl. VAT!");
  }
  if (toCents(f.amount_incl_vat) === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The invoice amount cannot be zero!");
  }

  if (f.vat_code) {
    const company = await SettingsService.getCompanySettings();
    const vat = (company.vat_rates as { code: string; rate: number; reverse_charge: boolean }[]).find((v) => v.code === f.vat_code);
    if (!vat) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Unknown VAT code ${f.vat_code}!`);
    }
    if (vat.reverse_charge && toCents(f.vat_amount) !== 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, "A reverse-charged invoice has no VAT amount!");
    }
  }

  let projectId = f.project_id ?? null;
  let purchaseOrderId = f.purchase_order_id ?? null;
  if (assignmentId) {
    // A subcontractor's invoice: from the assignment's subcontractor, never against a purchase order
    const a = await lockAssignment(client, assignmentId);
    if (a.subcontractor_id !== supplierId) {
      throw new ApiError(httpStatus.BAD_REQUEST, "This assignment belongs to another subcontractor!");
    }
    if (purchaseOrderId) {
      throw new ApiError(httpStatus.BAD_REQUEST, "A subcontractor invoice cannot also belong to a purchase order!");
    }
    if (isNew && !["CONFIRMED", "COMPLETED", "INVOICED"].includes(a.status)) {
      throw new ApiError(httpStatus.CONFLICT, "Invoices can only be recorded for a confirmed assignment!");
    }
    if (projectId && projectId !== a.project_id) {
      throw new ApiError(httpStatus.BAD_REQUEST, "The project does not match the assignment's project!");
    }
    projectId = a.project_id;
  }
  if (purchaseOrderId) {
    assertUuid(purchaseOrderId, "purchase order id");
    const po = await client.query(`SELECT id, status, supplier_id, project_id FROM purchase_orders WHERE id = $1::uuid`, [purchaseOrderId]);
    if (po.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Purchase order not found!");
    }
    if (po.rows[0].supplier_id !== supplierId) {
      throw new ApiError(httpStatus.BAD_REQUEST, "This purchase order belongs to another supplier!");
    }
    if (!["ORDERED", "PARTIALLY_RECEIVED", "RECEIVED"].includes(po.rows[0].status)) {
      throw new ApiError(httpStatus.CONFLICT, "The purchase order has not been ordered (or was cancelled)!");
    }
    if (projectId && po.rows[0].project_id && projectId !== po.rows[0].project_id) {
      throw new ApiError(httpStatus.BAD_REQUEST, "The project does not match the purchase order's project!");
    }
    projectId = projectId ?? po.rows[0].project_id ?? null;
  }
  if (projectId) {
    assertUuid(projectId, "project id");
    const project = await client.query(`SELECT id FROM projects WHERE id = $1::uuid`, [projectId]);
    if (project.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
    }
  }
  return { projectId, purchaseOrderId };
};

const assertNumberFree = async (client: any, supplierId: string, invoiceNumber: string, exceptId: string | null) => {
  const dup = await client.query(
    `SELECT id FROM supplier_invoices WHERE supplier_id = $1::uuid AND LOWER(invoice_number) = LOWER($2) AND status <> 'VOID' AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [supplierId, invoiceNumber, exceptId],
  );
  if (dup.rows.length > 0) {
    throw new ApiError(httpStatus.CONFLICT, `This supplier already has an invoice with number ${invoiceNumber}!`);
  }
};

const createSupplierInvoice = async (input: ICreateSupplierInvoice, actor: IActor) => {
  const id = await transaction(async (client) => {
    // an invoice from a supplier we no longer order from can still arrive
    const assignmentId = input.subcontract_assignment_id ?? null;
    const supplier = await loadSupplier(client, input.supplier_id, false, assignmentId ? "SUBCONTRACTOR" : "SUPPLIER");
    const number = input.invoice_number.trim();
    const { projectId, purchaseOrderId } = await validateFields(client, supplier.id, input, assignmentId, true);
    await assertNumberFree(client, supplier.id, number, null);

    const created = await client.query(
      `
        INSERT INTO supplier_invoices (
          supplier_id, purchase_order_id, project_id, invoice_number, invoice_date, due_date,
          amount_excl_vat, vat_amount, amount_incl_vat, vat_code, description, internal_notes, recorded_by,
          subcontract_assignment_id
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $12, $13::uuid, $14::uuid)
        RETURNING id
      `,
      [
        supplier.id, purchaseOrderId, projectId, number, input.invoice_date, input.due_date ?? null,
        input.amount_excl_vat, input.vat_amount, input.amount_incl_vat, input.vat_code ?? null,
        clean(input.description), clean(input.internal_notes), actor.id, assignmentId,
      ],
    );
    const invoiceId = created.rows[0].id as string;
    await logPurchasingEvent(
      client,
      supplier.id,
      { type: "supplier_invoice", id: invoiceId },
      "SUPPLIER_INVOICE_RECEIVED",
      `Invoice ${number} from ${supplier.name} recorded (${formatMoney(input.amount_incl_vat, "EN")})`,
      actor.id,
      { metadata: { project_id: projectId, purchase_order_id: purchaseOrderId, subcontract_assignment_id: assignmentId } },
    );
    if (assignmentId) {
      await logAssignmentEvent(
        client, supplier.id, assignmentId, "ASSIGNMENT_INVOICE_RECEIVED",
        `Invoice ${number} recorded for the assignment (${formatMoney(input.amount_incl_vat, "EN")})`, actor.id,
        { metadata: { supplier_invoice_id: invoiceId } },
      );
    }
    await logAudit(
      { actor_id: actor.id, action: "CREATE", entity_type: "supplier_invoice", entity_id: invoiceId, changes: { supplier_id: supplier.id, invoice_number: number, amount_incl_vat: input.amount_incl_vat } },
      client,
    );
    return invoiceId;
  }).catch((error: any) => {
    // Two requests recording the same invoice at once
    if (error?.code === "23505" && String(error?.constraint ?? "").includes("uq_supplier_invoices_number")) {
      throw new ApiError(httpStatus.CONFLICT, "This supplier already has an invoice with that number!");
    }
    throw error;
  });

  return getSupplierInvoiceById(id);
};

const lockInvoice = async (client: any, id: string) => {
  assertUuid(id, "supplier invoice id");
  const found = await client.query(
    `
      SELECT id, supplier_id, purchase_order_id, subcontract_assignment_id, project_id, invoice_number, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date,
             to_char(due_date, 'YYYY-MM-DD') AS due_date,
             amount_excl_vat::float8 AS amount_excl_vat, vat_amount::float8 AS vat_amount, amount_incl_vat::float8 AS amount_incl_vat,
             vat_code, status, recorded_by, (file_data IS NOT NULL) AS has_file
      FROM supplier_invoices WHERE id = $1::uuid FOR UPDATE
    `,
    [id],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Supplier invoice not found!");
  }
  return found.rows[0];
};

// A recorded invoice can be corrected until it is approved
const updateSupplierInvoice = async (id: string, payload: IUpdateSupplierInvoice, actor: IActor) => {
  await transaction(async (client) => {
    const inv = await lockInvoice(client, id);
    if (inv.status !== "RECEIVED") {
      throw new ApiError(httpStatus.CONFLICT, "Only an invoice that has not been approved yet can be changed. Unapprove it first!");
    }

    const merged: ISupplierInvoiceFields = {
      purchase_order_id: payload.purchase_order_id !== undefined ? payload.purchase_order_id : inv.purchase_order_id,
      project_id: payload.project_id !== undefined ? payload.project_id : inv.project_id,
      invoice_number: payload.invoice_number ?? inv.invoice_number,
      invoice_date: payload.invoice_date ?? inv.invoice_date,
      due_date: payload.due_date !== undefined ? payload.due_date : inv.due_date,
      amount_excl_vat: payload.amount_excl_vat ?? inv.amount_excl_vat,
      vat_amount: payload.vat_amount ?? inv.vat_amount,
      amount_incl_vat: payload.amount_incl_vat ?? inv.amount_incl_vat,
      vat_code: payload.vat_code !== undefined ? payload.vat_code : inv.vat_code,
    };
    const { projectId, purchaseOrderId } = await validateFields(client, inv.supplier_id, merged, inv.subcontract_assignment_id ?? null);
    const number = merged.invoice_number.trim();
    if (number.toLowerCase() !== String(inv.invoice_number).toLowerCase()) await assertNumberFree(client, inv.supplier_id, number, id);

    await client.query(
      `
        UPDATE supplier_invoices
        SET purchase_order_id = $2::uuid, project_id = $3::uuid, invoice_number = $4, invoice_date = $5::date, due_date = $6::date,
            amount_excl_vat = $7, vat_amount = $8, amount_incl_vat = $9, vat_code = $10,
            description = CASE WHEN $11::boolean THEN $12 ELSE description END,
            internal_notes = CASE WHEN $13::boolean THEN $14 ELSE internal_notes END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [
        id, purchaseOrderId, projectId, number, merged.invoice_date, merged.due_date ?? null,
        merged.amount_excl_vat, merged.vat_amount, merged.amount_incl_vat, merged.vat_code ?? null,
        payload.description !== undefined, clean(payload.description),
        payload.internal_notes !== undefined, clean(payload.internal_notes),
      ],
    );
    await logAudit({ actor_id: actor.id, action: "UPDATE", entity_type: "supplier_invoice", entity_id: id, changes: { fields: Object.keys(payload) } }, client);
  }).catch((error: any) => {
    if (error?.code === "23505" && String(error?.constraint ?? "").includes("uq_supplier_invoices_number")) {
      throw new ApiError(httpStatus.CONFLICT, "This supplier already has an invoice with that number!");
    }
    throw error;
  });

  return getSupplierInvoiceById(id);
};

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

// Attaches (or replaces) the supplier's invoice: a PDF or a photo, checked by its real bytes
const uploadFile = async (id: string, file: any, actor: IActor) => {
  assertUuid(id, "supplier invoice id");
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No file uploaded!");
  }
  const name = path.basename(String(file.originalname ?? "invoice")).replace(/[\u0000-\u001f]/g, "").slice(0, 255);
  if (file.buffer.length > MAX_FILE_BYTES) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${name}: the file is larger than 10 MB!`);
  }
  const type = detectFileType(file.buffer);
  if (!type) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${name}: only PDF, JPEG, PNG and WebP files are allowed!`);
  }

  await transaction(async (client) => {
    const inv = await lockInvoice(client, id);
    if (inv.status === "VOID" || inv.status === "PAID") {
      throw new ApiError(httpStatus.CONFLICT, "The document of a paid or voided invoice can no longer be changed!");
    }
    await client.query(
      `UPDATE supplier_invoices SET file_data = $2, file_name = $3, file_mime = $4, file_size = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, file.buffer, name, type.mime, file.buffer.length],
    );
    await logAudit({ actor_id: actor.id, action: "UPDATE", entity_type: "supplier_invoice", entity_id: id, changes: { file: name, replaced: inv.has_file } }, client);
  });

  return getSupplierInvoiceById(id);
};

const getFile = async (id: string) => {
  assertUuid(id, "supplier invoice id");
  const found = await query(`SELECT file_data, file_name, file_mime FROM supplier_invoices WHERE id = $1::uuid`, [id]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Supplier invoice not found!");
  }
  if (!found.rows[0].file_data) {
    throw new ApiError(httpStatus.NOT_FOUND, "No document is attached to this invoice!");
  }
  return { data: found.rows[0].file_data as Buffer, name: found.rows[0].file_name as string, mime: found.rows[0].file_mime as string };
};

// ---------------------------------------------------------------------------
// Approval (FR-PUR-04)
// ---------------------------------------------------------------------------

const approve = async (id: string, actor: IActor) => {
  await transaction(async (client) => {
    const inv = await lockInvoice(client, id);
    if (inv.status !== "RECEIVED") {
      throw new ApiError(httpStatus.CONFLICT, inv.status === "APPROVED" ? "This invoice has already been approved!" : "Only a received invoice can be approved!");
    }
    if (!inv.has_file) {
      throw new ApiError(httpStatus.CONFLICT, "Attach the supplier's invoice (the document) before approving!");
    }
    // The person who records an invoice does not approve it (the Beheerder can)
    if (inv.recorded_by === actor.id && actor.role === "OFFICE") {
      throw new ApiError(httpStatus.FORBIDDEN, "You cannot approve an invoice you recorded yourself. Ask a colleague or an admin!");
    }
    await client.query(
      `UPDATE supplier_invoices SET status = 'APPROVED', approved_by = $2::uuid, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, actor.id],
    );
    await logPurchasingEvent(client, inv.supplier_id, { type: "supplier_invoice", id }, "SUPPLIER_INVOICE_APPROVED", `Invoice ${inv.invoice_number} approved`, actor.id);
    await syncAssignmentInvoiced(client, inv.subcontract_assignment_id, actor.id);
    await logAudit({ actor_id: actor.id, action: "STATUS_CHANGE", entity_type: "supplier_invoice", entity_id: id, changes: { to: "APPROVED", amount_incl_vat: inv.amount_incl_vat } }, client);
  });
  // An approved supplier / subcontractor invoice is sent to SnelStart as a purchase booking
  await enqueueSnelStart("PURCHASE_INVOICE", id, actor.id);
  return getSupplierInvoiceById(id);
};

const unapprove = async (id: string, actor: IActor) => {
  await transaction(async (client) => {
    const inv = await lockInvoice(client, id);
    if (inv.status !== "APPROVED") {
      throw new ApiError(httpStatus.CONFLICT, "Only an approved invoice can be unapproved!");
    }
    await client.query(
      `UPDATE supplier_invoices SET status = 'RECEIVED', approved_by = NULL, approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id],
    );
    await logPurchasingEvent(client, inv.supplier_id, { type: "supplier_invoice", id }, "SUPPLIER_INVOICE_UNAPPROVED", `Invoice ${inv.invoice_number} unapproved`, actor.id);
    await syncAssignmentInvoiced(client, inv.subcontract_assignment_id, actor.id);
    await logAudit({ actor_id: actor.id, action: "STATUS_CHANGE", entity_type: "supplier_invoice", entity_id: id, changes: { to: "RECEIVED", unapproved: true } }, client);
  });
  await withdrawFromSnelStart(id, "The invoice was unapproved");
  return getSupplierInvoiceById(id);
};

const pay = async (id: string, input: IPaySupplierInvoice, actor: IActor) => {
  const paidAt = input.paid_at ?? amsterdamToday();
  if (paidAt > amsterdamToday()) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The payment date cannot be in the future!");
  }

  await transaction(async (client) => {
    const inv = await lockInvoice(client, id);
    if (inv.status !== "APPROVED") {
      throw new ApiError(httpStatus.CONFLICT, inv.status === "PAID" ? "This invoice has already been paid!" : "Only an approved invoice can be marked as paid!");
    }
    if (paidAt < inv.invoice_date) {
      throw new ApiError(httpStatus.BAD_REQUEST, "The payment date cannot be before the invoice date!");
    }
    await client.query(
      `UPDATE supplier_invoices SET status = 'PAID', paid_at = $2::date, payment_reference = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, paidAt, clean(input.reference)],
    );
    await logPurchasingEvent(client, inv.supplier_id, { type: "supplier_invoice", id }, "SUPPLIER_INVOICE_PAID", `Invoice ${inv.invoice_number} paid`, actor.id, {
      description: clean(input.reference),
    });
    await logAudit({ actor_id: actor.id, action: "STATUS_CHANGE", entity_type: "supplier_invoice", entity_id: id, changes: { to: "PAID", paid_at: paidAt } }, client);
  });
  return getSupplierInvoiceById(id);
};

// A record entered by mistake (or a duplicate): kept for the record, no longer counted
const voidInvoice = async (id: string, reason: string, actor: IActor) => {
  await transaction(async (client) => {
    const inv = await lockInvoice(client, id);
    if (inv.status === "PAID") {
      throw new ApiError(httpStatus.CONFLICT, "A paid invoice cannot be voided!");
    }
    if (inv.status === "VOID") {
      throw new ApiError(httpStatus.CONFLICT, "This invoice has already been voided!");
    }
    await client.query(
      `UPDATE supplier_invoices SET status = 'VOID', voided_at = CURRENT_TIMESTAMP, void_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, reason.trim()],
    );
    await logPurchasingEvent(client, inv.supplier_id, { type: "supplier_invoice", id }, "SUPPLIER_INVOICE_VOIDED", `Invoice ${inv.invoice_number} voided`, actor.id, {
      description: reason.trim(),
    });
    await syncAssignmentInvoiced(client, inv.subcontract_assignment_id, actor.id);
    await logAudit({ actor_id: actor.id, action: "STATUS_CHANGE", entity_type: "supplier_invoice", entity_id: id, changes: { to: "VOID", reason: reason.trim() } }, client);
  });
  await withdrawFromSnelStart(id, "The invoice was voided");
  return getSupplierInvoiceById(id);
};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

// What still has to be approved and paid, and what is late
const getOverview = async () => {
  const result = await query(
    `
      SELECT
        COUNT(*) FILTER (WHERE status = 'RECEIVED')::int AS received_count,
        COALESCE(SUM(amount_incl_vat) FILTER (WHERE status = 'RECEIVED'), 0)::float8 AS received_amount,
        COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS approved_count,
        COALESCE(SUM(amount_incl_vat) FILTER (WHERE status = 'APPROVED'), 0)::float8 AS approved_amount,
        COUNT(*) FILTER (WHERE status = 'RECEIVED' AND file_data IS NULL)::int AS missing_file,
        COUNT(*) FILTER (WHERE status IN ('RECEIVED', 'APPROVED') AND due_date < ${todaySql})::int AS overdue_count,
        COALESCE(SUM(amount_incl_vat) FILTER (WHERE status IN ('RECEIVED', 'APPROVED') AND due_date < ${todaySql}), 0)::float8 AS overdue_amount,
        COUNT(*) FILTER (WHERE status IN ('RECEIVED', 'APPROVED') AND due_date BETWEEN ${todaySql} AND ${todaySql} + 7)::int AS soon_count,
        COALESCE(SUM(amount_incl_vat) FILTER (WHERE status IN ('RECEIVED', 'APPROVED') AND due_date BETWEEN ${todaySql} AND ${todaySql} + 7), 0)::float8 AS soon_amount
      FROM supplier_invoices
    `,
  );
  const r = result.rows[0];
  return {
    awaiting_approval: { invoices: r.received_count, amount: round2(r.received_amount), without_document: r.missing_file },
    approved_unpaid: { invoices: r.approved_count, amount: round2(r.approved_amount) },
    overdue: { invoices: r.overdue_count, amount: round2(r.overdue_amount) },
    due_within_7_days: { invoices: r.soon_count, amount: round2(r.soon_amount) },
  };
};

// ---------------------------------------------------------------------------
// Export (FR-PUR-06)
// ---------------------------------------------------------------------------

const exportRange = (params: Record<string, any>) => {
  if (!params.from || !params.to) {
    throw new ApiError(httpStatus.BAD_REQUEST, "from and to are required (e.g. from=2026-11-01&to=2026-11-30)!");
  }
  const from = assertDay(params.from, "from");
  const to = assertDay(params.to, "to");
  if (to < from) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The end of the period cannot be before its start!");
  }
  const days = Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000) + 1;
  if (days > MAX_EXPORT_DAYS) {
    throw new ApiError(httpStatus.BAD_REQUEST, `A period can be at most ${MAX_EXPORT_DAYS} days!`);
  }
  return { from, to };
};

// Voided entries are left out unless asked for (status=ALL)
const exportFilter = (params: Record<string, any>) => {
  const values: any[] = [];
  let where = `si.invoice_date BETWEEN $1::date AND $2::date`;
  const status = String(params.status ?? "").toUpperCase();
  if (status && status !== "ALL") {
    const statuses = asList(status);
    if (statuses.some((s) => !(supplierInvoiceStatuses as readonly string[]).includes(s))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Status should be RECEIVED, APPROVED, PAID, VOID or ALL!");
    }
    values.push(statuses);
    where += ` AND si.status = ANY($3::"SupplierInvoiceStatus"[])`;
  } else if (!status) {
    where += ` AND si.status <> 'VOID'`;
  }
  if (params.supplier_id) {
    assertUuid(String(params.supplier_id), "supplier id");
    values.push(String(params.supplier_id));
    where += ` AND si.supplier_id = $${values.length + 2}::uuid`;
  }
  return { where, values };
};

const exportCsv = async (params: Record<string, any>) => {
  const { from, to } = exportRange(params);
  const delimiter = csvDelimiter(params.delimiter);
  const { where, values } = exportFilter(params);

  const result = await query(
    `
      SELECT s.name AS supplier, si.invoice_number, to_char(si.invoice_date, 'YYYY-MM-DD') AS invoice_date,
             to_char(si.due_date, 'YYYY-MM-DD') AS due_date, p.number AS project_number, po.number AS po_number, sa.number AS assignment_number,
             si.amount_excl_vat::float8 AS excl, si.vat_amount::float8 AS vat, si.amount_incl_vat::float8 AS incl,
             si.vat_code, si.status, au.name AS approved_by, to_char(si.approved_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD') AS approved_on,
             to_char(si.paid_at, 'YYYY-MM-DD') AS paid_on, si.payment_reference, (si.file_data IS NOT NULL) AS has_file, si.description
      FROM supplier_invoices si
      JOIN relations s ON s.id = si.supplier_id
      LEFT JOIN projects p ON p.id = si.project_id
      LEFT JOIN purchase_orders po ON po.id = si.purchase_order_id
      LEFT JOIN subcontract_assignments sa ON sa.id = si.subcontract_assignment_id
      LEFT JOIN users au ON au.id = si.approved_by
      WHERE ${where}
      ORDER BY si.invoice_date ASC, LOWER(s.name) ASC, si.invoice_number ASC
    `,
    [from, to, ...values],
  );

  const money = (v: number) => csvAmount(v, delimiter);
  const rows: any[][] = [
    ["Supplier", "Invoice number", "Invoice date", "Due date", "Project", "Purchase order", "Assignment", "Excl. VAT", "VAT", "Incl. VAT", "VAT code", "Status", "Approved by", "Approved on", "Paid on", "Payment reference", "Document attached", "Description"],
    ...result.rows.map((r: any) => [
      r.supplier, r.invoice_number, r.invoice_date, r.due_date, r.project_number, r.po_number, r.assignment_number,
      money(r.excl), money(r.vat), money(r.incl), r.vat_code, r.status, r.approved_by, r.approved_on, r.paid_on,
      r.payment_reference, r.has_file ? "Yes" : "No", r.description,
    ]),
  ];
  return { csv: buildCsv(rows, delimiter), filename: `supplier-invoices_${from}_${to}.csv` };
};

// The attached documents of the same invoices in one ZIP
const exportFiles = async (params: Record<string, any>) => {
  const { from, to } = exportRange(params);
  const { where, values } = exportFilter(params);

  const result = await query(
    `
      SELECT si.id, s.name AS supplier, si.invoice_number, to_char(si.invoice_date, 'YYYY-MM-DD') AS invoice_date,
             si.file_data, si.file_mime
      FROM supplier_invoices si JOIN relations s ON s.id = si.supplier_id
      WHERE ${where} AND si.file_data IS NOT NULL
      ORDER BY si.invoice_date ASC, LOWER(s.name) ASC, si.invoice_number ASC
      LIMIT ${MAX_EXPORT_FILES + 1}
    `,
    [from, to, ...values],
  );
  if (result.rows.length > MAX_EXPORT_FILES) {
    throw new ApiError(httpStatus.BAD_REQUEST, `That is more than ${MAX_EXPORT_FILES} documents. Choose a shorter period!`);
  }
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "There are no documents in this period!");
  }

  const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";
  const used = new Set<string>();
  const files = result.rows.map((r: any) => {
    let name = `${r.invoice_date}_${safe(r.supplier)}_${safe(r.invoice_number)}.${extensions[r.file_mime] ?? "bin"}`;
    // two invoices that would get the same name: keep both
    if (used.has(name)) name = name.replace(/(\.[a-z]+)$/, `_${String(r.id).slice(0, 8)}$1`);
    used.add(name);
    return { name, data: r.file_data as Buffer };
  });
  return { zip: createZip(files), filename: `supplier-invoices_${from}_${to}.zip` };
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const getHistory = async (id: string, params: Record<string, any>) => {
  assertUuid(id, "supplier invoice id");
  const exists = await query(`SELECT 1 FROM supplier_invoices WHERE id = $1::uuid`, [id]);
  if (exists.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Supplier invoice not found!");
  }

  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const scope = `t.entity_type = 'supplier_invoice' AND t.entity_id = $1::uuid`;
  const [result, count] = await Promise.all([
    query(
      `
        SELECT t.id, t.event_type, t.entity_id, t.title, t.description, t.metadata, t.actor_id,
               u.name AS actor_name, t.created_at AS "createdAt"
        FROM relation_timeline t LEFT JOIN users u ON u.id = t.actor_id
        WHERE ${scope} ORDER BY t.created_at DESC, t.id DESC LIMIT $2 OFFSET $3
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

export const SupplierInvoiceService = {
  createSupplierInvoice,
  getAllSupplierInvoices,
  getSupplierInvoiceById,
  updateSupplierInvoice,
  uploadFile,
  getFile,
  approve,
  unapprove,
  pay,
  voidInvoice,
  getOverview,
  exportCsv,
  exportFiles,
  getHistory,
};
