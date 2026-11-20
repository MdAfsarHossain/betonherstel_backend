import path from "path";
import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { query } from "../../utils/db";
import { detectFileType } from "../../utils/fileType";
import { ChatService } from "../chat/chat.service";
import { chatUnreadByProject } from "../chat/chat.shared";
import { RelationService } from "../relation/relation.service";
import { clean, loadPortalUser, round2 } from "../portal/portal.shared";
import { ProjectService } from "../project/project.service";
import { SupplierInvoiceService } from "../purchasing/supplierinvoice.service";
import { SubcontractingService } from "../subcontracting/subcontracting.service";
import { invoiceForm } from "./subportal.validation";
import { notifyOfficeAboutAssignment } from "./subportal.shared";

// The subcontractor portal (SRS 4.19). Everything here is for a signed-in subcontractor (role
// SUBCONTRACTOR) and limited to the assignments issued to their own company. What they see is built
// from explicit columns: no customer, no customer prices, no main quotation, no internal notes and
// nothing of other subcontractors can leak (FR-SUBP-08). The actions reuse the office's own functions
// (answer, progress, complete, record an invoice), so the rules are the same in both places.

const MAX_INVOICE_BYTES = 10 * 1024 * 1024;
const loadUser = (userId: string) => loadPortalUser(userId, "SUBCONTRACTOR");
const notFound = (what: string) => new ApiError(httpStatus.NOT_FOUND, `${what} not found!`);

const paged = (rows: any[], total: number, page: number, limit: number) => {
  const totalPage = Math.ceil(total / limit);
  return { data: rows, meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 } };
};

// ---------------------------------------------------------------------------
// The subcontractor's own details (FR-SUBP-09)
// ---------------------------------------------------------------------------

const getMe = async (userId: string) => {
  const user = await loadUser(userId);
  const result = await query(
    `
      SELECT u.id, u.name, u.email, u.phone_number, u.preferred_language::text AS preferred_language, u.last_login_at,
             json_build_object('id', r.id, 'name', r.name, 'email', r.email, 'phone', r.phone) AS company
      FROM users u JOIN relations r ON r.id = u.relation_id WHERE u.id = $1::uuid
    `,
    [user.id],
  );
  return result.rows[0];
};

const updateMe = async (userId: string, payload: { name?: string; phone_number?: string | null; preferred_language?: "NL" | "EN" }) => {
  const user = await loadUser(userId);
  const updates: string[] = [];
  const values: any[] = [user.id];
  let n = 2;
  if (payload.name !== undefined) {
    updates.push(`name = $${n++}`);
    values.push(payload.name.trim());
  }
  if (payload.phone_number !== undefined) {
    updates.push(`phone_number = $${n++}`);
    values.push(clean(payload.phone_number));
  }
  if (payload.preferred_language !== undefined) {
    updates.push(`preferred_language = $${n++}::"Language"`);
    values.push(payload.preferred_language);
  }
  updates.push("updated_at = CURRENT_TIMESTAMP");
  await query(`UPDATE users SET ${updates.join(", ")} WHERE id = $1::uuid`, values);
  return getMe(userId);
};

// The company's phone and email on the relation. The office sees the change on the timeline.
const updateCompany = async (userId: string, payload: { phone?: string | null; email?: string | null }) => {
  const user = await loadUser(userId);
  const updates: string[] = [];
  const values: any[] = [user.relation_id];
  let n = 2;
  if (payload.phone !== undefined) {
    updates.push(`phone = $${n++}`);
    values.push(clean(payload.phone));
  }
  if (payload.email !== undefined) {
    updates.push(`email = $${n++}`);
    values.push(clean(payload.email)?.toLowerCase() ?? null);
  }
  updates.push("updated_at = CURRENT_TIMESTAMP");
  await query(`UPDATE relations SET ${updates.join(", ")} WHERE id = $1::uuid`, values);
  await RelationService.logRelationEvent(user.relation_id, {
    event_type: "PORTAL_COMPANY_DETAILS_CHANGED",
    entity_type: "user",
    entity_id: user.id,
    title: `${user.name} changed the company contact details in the portal`,
    actor_id: user.id,
  });
  return getMe(userId);
};

// ---------------------------------------------------------------------------
// Assignments (FR-SUBP-03)
// ---------------------------------------------------------------------------

// Only what was issued to this company; a draft was never issued
const scope = `sa.subcontractor_id = $1::uuid AND sa.status <> 'DRAFT'`;

const listColumns = `
  sa.id, sa.number, sa.status, sa.title, sa.agreed_price_excl_vat::float8 AS agreed_price_excl_vat,
  sa.vat_code, sa.vat_reverse_charge,
  to_char(sa.planned_start, 'YYYY-MM-DD') AS planned_start, to_char(sa.planned_end, 'YYYY-MM-DD') AS planned_end,
  sa.progress_percent, sa.sent_at, sa.responded_at,
  json_build_object('number', p.number, 'title', p.title) AS project, sa.project_id
`;

// Unread messages in this company's chat channel on the assignment's project, for this person
const withChatUnread = async (user: { id: string; relation_id: string }, rows: any[]) => {
  const unread = await chatUnreadByProject(user.id, [...new Set(rows.map((r) => r.project_id))], "SUBCONTRACTOR", user.relation_id);
  return rows.map((r) => ({ ...r, unread_messages: unread.get(r.project_id) ?? 0 }));
};


const getAssignments = async (userId: string, params: Record<string, any>) => {
  const user = await loadUser(userId);
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const conditions = [scope];
  const values: any[] = [user.relation_id];
  let n = 2;
  if (params.status) {
    const statuses = String(Array.isArray(params.status) ? params.status.join(",") : params.status).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (statuses.some((s) => !["SENT", "CONFIRMED", "DECLINED", "COMPLETED", "INVOICED", "CANCELLED"].includes(s))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Status should be SENT, CONFIRMED, DECLINED, COMPLETED, INVOICED or CANCELLED!");
    }
    conditions.push(`sa.status = ANY($${n++}::text[])`);
    values.push(statuses);
  }
  const where = conditions.join(" AND ");
  const [rows, count] = await Promise.all([
    query(
      `SELECT ${listColumns} FROM subcontract_assignments sa JOIN projects p ON p.id = sa.project_id WHERE ${where}
       ORDER BY (sa.status = 'SENT') DESC, sa.planned_start ASC NULLS LAST, sa.created_at DESC, sa.id DESC LIMIT $${n} OFFSET $${n + 1}`,
      [...values, limit, skip],
    ),
    query(`SELECT COUNT(*)::int AS total FROM subcontract_assignments sa WHERE ${where}`, values),
  ]);
  return paged(await withChatUnread(user, rows.rows), count.rows[0].total, page, limit);
};

const loadOwn = async (relationId: string, id: string) => {
  assertUuid(id, "assignment id");
  const found = await query(`SELECT sa.id, sa.status, sa.number, sa.project_id FROM subcontract_assignments sa WHERE sa.id = $2::uuid AND ${scope}`, [relationId, id]);
  if (found.rows.length === 0) throw notFound("Assignment");
  return found.rows[0];
};

const getAssignmentById = async (userId: string, id: string) => {
  const user = await loadUser(userId);
  const own = await loadOwn(user.relation_id, id);

  const [head, progress, files, invoices] = await Promise.all([
    query(
      `
        SELECT ${listColumns}, sa.scope_description, sa.language::text AS language,
               sa.work_street, sa.work_house_number, sa.work_postcode, sa.work_city, sa.work_country,
               sa.response_via, sa.response_comment, to_char(sa.proposed_start, 'YYYY-MM-DD') AS proposed_start, to_char(sa.proposed_end, 'YYYY-MM-DD') AS proposed_end,
               sa.completed_at, sa.completed_note, sa.cancelled_at,
               (sa.pdf_data IS NOT NULL) AS has_pdf
        FROM subcontract_assignments sa JOIN projects p ON p.id = sa.project_id WHERE sa.id = $1::uuid
      `,
      [id],
    ),
    query(`SELECT percent, note, created_at AS "createdAt" FROM subcontract_progress WHERE assignment_id = $1::uuid ORDER BY created_at DESC, id DESC`, [id]),
    // what the office shared with them (drawings, specifications) and what they uploaded themselves;
    // never another subcontractor's files or anything not marked as shared
    query(
      `
        SELECT f.id, f.folder, f.file_name, f.mime_type, f.size_bytes, f.caption, f.file_url, f.created_at AS "createdAt",
               (f.subcontract_assignment_id = $1::uuid) AS is_assignment_file, (f.uploaded_by = $2::uuid) AS uploaded_by_me
        FROM project_files f
        WHERE f.project_id = $3::uuid AND f.share_with_subcontractor AND (f.subcontract_assignment_id = $1::uuid OR f.subcontract_assignment_id IS NULL)
        ORDER BY f.created_at ASC
      `,
      [id, user.id, own.project_id],
    ),
    query(
      `
        SELECT id, invoice_number, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(due_date, 'YYYY-MM-DD') AS due_date,
               amount_excl_vat::float8 AS amount_excl_vat, vat_amount::float8 AS vat_amount, amount_incl_vat::float8 AS amount_incl_vat,
               vat_code, status, to_char(paid_at, 'YYYY-MM-DD') AS paid_at, (file_data IS NOT NULL) AS has_file
        FROM supplier_invoices WHERE subcontract_assignment_id = $1::uuid AND supplier_id = $2::uuid ORDER BY created_at ASC
      `,
      [id, user.relation_id],
    ),
  ]);

  const a = (await withChatUnread(user, head.rows))[0];
  const { work_street, work_house_number, work_postcode, work_city, work_country, ...rest } = a;
  const live = invoices.rows.filter((i: any) => i.status !== "VOID");
  const invoicedCents = live.reduce((n: number, i: any) => n + Math.round(i.amount_excl_vat * 100), 0);
  const status = a.status as string;
  return {
    ...rest,
    work_address: work_street ? { street: work_street, house_number: work_house_number, postcode: work_postcode, city: work_city, country: work_country } : null,
    progress: progress.rows,
    files: files.rows,
    invoices: invoices.rows,
    invoiced_excl_vat: round2(invoicedCents / 100),
    can_respond: status === "SENT",
    can_report_progress: status === "CONFIRMED",
    can_complete: status === "CONFIRMED",
    can_upload_files: ["CONFIRMED", "COMPLETED"].includes(status),
    can_upload_invoice: ["COMPLETED", "INVOICED"].includes(status),
  };
};

// The work instruction as it was sent
const getAssignmentPdf = async (userId: string, id: string) => {
  const user = await loadUser(userId);
  await loadOwn(user.relation_id, id);
  return SubcontractingService.getPdf(id);
};

// ---------------------------------------------------------------------------
// Answering, progress, completing (FR-SUBP-04, FR-SUBP-05)
// ---------------------------------------------------------------------------

const respond = async (userId: string, id: string, input: { response: "CONFIRM" | "DECLINE"; comment?: string | null; proposed_start?: string | null; proposed_end?: string | null }) => {
  const user = await loadUser(userId);
  await loadOwn(user.relation_id, id);
  // The service notifies the office user who made the assignment
  await SubcontractingService.respondAssignment(id, { ...input, via: "PORTAL" }, user.id);
  return getAssignmentById(userId, id);
};

const reportProgress = async (userId: string, id: string, input: { percent: number; note?: string | null }) => {
  const user = await loadUser(userId);
  const own = await loadOwn(user.relation_id, id);
  await SubcontractingService.reportProgress(id, { ...input, via: "PORTAL" }, user.id);
  await notifyOfficeAboutAssignment(id, `${user.name} reported ${input.percent}% on assignment ${own.number}`, input.note, user.id);
  return getAssignmentById(userId, id);
};

const complete = async (userId: string, id: string, note: string | null | undefined) => {
  const user = await loadUser(userId);
  const own = await loadOwn(user.relation_id, id);
  await SubcontractingService.completeAssignment(id, { note }, user.id);
  await notifyOfficeAboutAssignment(id, `${user.name} marked assignment ${own.number} as complete`, note, user.id);
  return getAssignmentById(userId, id);
};

// ---------------------------------------------------------------------------
// Photos and documents (FR-SUBP-05)
// ---------------------------------------------------------------------------

// They are shared with the subcontractor (it is their own upload) and never with the customer:
// whatever the form says, those two flags are fixed here
const addFiles = async (userId: string, id: string, files: any[], fields: Record<string, any>) => {
  const user = await loadUser(userId);
  const own = await loadOwn(user.relation_id, id);
  if (!["CONFIRMED", "COMPLETED"].includes(own.status)) {
    throw new ApiError(httpStatus.CONFLICT, "Files can be added once the assignment is confirmed, and until it is invoiced!");
  }
  const saved = await ProjectService.addFiles(
    own.project_id,
    files,
    { folder: fields.folder, caption: fields.caption, share_with_subcontractor: true, share_with_customer: false },
    user.id,
    { assignmentId: id, defaultFolder: "DURING" },
  );
  await notifyOfficeAboutAssignment(id, `${user.name} added ${saved.length} file${saved.length === 1 ? "" : "s"} to assignment ${own.number}`, saved.map((f: any) => f.file_name).join(", "), user.id);
  return saved.map(({ project_id, ...f }: any) => f);
};

// Their own uploads only, while the work is still running
const deleteFile = async (userId: string, id: string, fileId: string) => {
  const user = await loadUser(userId);
  const own = await loadOwn(user.relation_id, id);
  assertUuid(fileId, "file id");
  const found = await query(`SELECT project_id FROM project_files WHERE id = $1::uuid AND subcontract_assignment_id = $2::uuid AND uploaded_by = $3::uuid`, [fileId, id, user.id]);
  if (found.rows.length === 0) throw notFound("File");
  if (own.status !== "CONFIRMED") {
    throw new ApiError(httpStatus.CONFLICT, "Files can only be removed while the assignment is in progress!");
  }
  await ProjectService.deleteFile(found.rows[0].project_id, fileId, user.id);
};

// ---------------------------------------------------------------------------
// Invoices (FR-SUBP-06)
// ---------------------------------------------------------------------------

const invoiceColumns = `
  si.id, si.invoice_number, to_char(si.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(si.due_date, 'YYYY-MM-DD') AS due_date,
  si.amount_excl_vat::float8 AS amount_excl_vat, si.vat_amount::float8 AS vat_amount, si.amount_incl_vat::float8 AS amount_incl_vat,
  si.vat_code, si.status, si.description, to_char(si.paid_at, 'YYYY-MM-DD') AS paid_at, (si.file_data IS NOT NULL) AS has_file,
  si.created_at AS "createdAt",
  json_build_object('id', sa.id, 'number', sa.number, 'title', sa.title) AS assignment
`;

const readInvoice = async (relationId: string, id: string) => {
  assertUuid(id, "invoice id");
  const found = await query(
    `SELECT ${invoiceColumns} FROM supplier_invoices si JOIN subcontract_assignments sa ON sa.id = si.subcontract_assignment_id WHERE si.id = $1::uuid AND si.supplier_id = $2::uuid`,
    [id, relationId],
  );
  if (found.rows.length === 0) throw notFound("Invoice");
  return found.rows[0];
};

const getInvoices = async (userId: string, params: Record<string, any>) => {
  const user = await loadUser(userId);
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const [rows, count] = await Promise.all([
    query(
      `SELECT ${invoiceColumns} FROM supplier_invoices si JOIN subcontract_assignments sa ON sa.id = si.subcontract_assignment_id
       WHERE si.supplier_id = $1::uuid ORDER BY si.invoice_date DESC, si.id DESC LIMIT $2 OFFSET $3`,
      [user.relation_id, limit, skip],
    ),
    query(`SELECT COUNT(*)::int AS total FROM supplier_invoices WHERE supplier_id = $1::uuid AND subcontract_assignment_id IS NOT NULL`, [user.relation_id]),
  ]);
  return paged(rows.rows, count.rows[0].total, page, limit);
};

const getInvoiceById = async (userId: string, id: string) => {
  const user = await loadUser(userId);
  return readInvoice(user.relation_id, id);
};

// The uploaded document is checked before anything is recorded, so a bad file does not leave an
// invoice without its PDF behind
const checkInvoiceFile = (files: any[]) => {
  const file = files?.[0];
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Attach your invoice as a PDF!");
  }
  const name = path.basename(String(file.originalname ?? "invoice")).replace(/[\u0000-\u001f]/g, "").slice(0, 255);
  if (file.buffer.length > MAX_INVOICE_BYTES) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${name}: the file is larger than 10 MB!`);
  }
  const type = detectFileType(file.buffer);
  if (!type || type.mime !== "application/pdf") {
    throw new ApiError(httpStatus.BAD_REQUEST, `${name}: the invoice must be a PDF!`);
  }
  return file;
};

// Against a completed assignment: the amounts (reverse-charged VAT included) and the PDF go to the
// office for review. It is an ordinary supplier invoice linked to the assignment (FR-SUB-04).
const uploadInvoice = async (userId: string, id: string, fields: Record<string, any>, files: any[]) => {
  const user = await loadUser(userId);
  const own = await loadOwn(user.relation_id, id);
  if (!["COMPLETED", "INVOICED"].includes(own.status)) {
    throw new ApiError(httpStatus.CONFLICT, "Mark the assignment as complete before you upload your invoice!");
  }
  const input = invoiceForm.parse(fields);
  const file = checkInvoiceFile(files);

  const actor = { id: user.id, role: "SUBCONTRACTOR" };
  const created: any = await SubcontractingService.recordInvoice(id, { ...input, due_date: input.due_date ?? null }, actor);
  try {
    await SupplierInvoiceService.uploadFile(created.id, file, actor);
  } catch (error) {
    // Never leave an invoice without its document: void it so the number can be used again
    await SupplierInvoiceService.voidInvoice(created.id, "The document could not be saved", actor).catch(() => undefined);
    throw error;
  }
  await notifyOfficeAboutAssignment(id, `${user.name} uploaded invoice ${input.invoice_number} for assignment ${own.number}`, `${input.amount_excl_vat} excl. VAT`, user.id);
  return readInvoice(user.relation_id, created.id);
};

// Replace the PDF while the office has not approved the invoice yet
const replaceInvoiceFile = async (userId: string, id: string, files: any[]) => {
  const user = await loadUser(userId);
  const inv = await readInvoice(user.relation_id, id);
  if (inv.status !== "RECEIVED") {
    throw new ApiError(httpStatus.CONFLICT, "The document can only be replaced while the invoice has not been approved yet!");
  }
  await SupplierInvoiceService.uploadFile(id, checkInvoiceFile(files), { id: user.id, role: "SUBCONTRACTOR" });
  return readInvoice(user.relation_id, id);
};

const getInvoiceFile = async (userId: string, id: string) => {
  const user = await loadUser(userId);
  await readInvoice(user.relation_id, id);
  return SupplierInvoiceService.getFile(id);
};

// ---------------------------------------------------------------------------
// The home page
// ---------------------------------------------------------------------------

const getHome = async (userId: string) => {
  const user = await loadUser(userId);
  const rel = user.relation_id;
  const [counts, awaiting, active, toInvoice, messages] = await Promise.all([
    query(
      `
        SELECT COUNT(*) FILTER (WHERE status = 'SENT')::int AS awaiting_answer,
               COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int AS in_progress,
               COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_not_invoiced,
               COUNT(*) FILTER (WHERE status = 'INVOICED')::int AS invoiced
        FROM subcontract_assignments sa WHERE ${scope}
      `,
      [rel],
    ),
    query(`SELECT ${listColumns} FROM subcontract_assignments sa JOIN projects p ON p.id = sa.project_id WHERE ${scope} AND sa.status = 'SENT' ORDER BY sa.sent_at ASC LIMIT 10`, [rel]),
    query(`SELECT ${listColumns} FROM subcontract_assignments sa JOIN projects p ON p.id = sa.project_id WHERE ${scope} AND sa.status = 'CONFIRMED' ORDER BY sa.planned_start ASC NULLS LAST LIMIT 10`, [rel]),
    query(
      `SELECT ${listColumns} FROM subcontract_assignments sa JOIN projects p ON p.id = sa.project_id
       WHERE ${scope} AND sa.status = 'COMPLETED' AND NOT EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.subcontract_assignment_id = sa.id AND si.status <> 'VOID')
       ORDER BY sa.completed_at ASC LIMIT 10`,
      [rel],
    ),
    ChatService.getUnreadSummary(user.id),
  ]);
  return {
    counts: counts.rows[0],
    awaiting_your_answer: await withChatUnread(user, awaiting.rows),
    in_progress: await withChatUnread(user, active.rows),
    ready_to_invoice: await withChatUnread(user, toInvoice.rows),
    unread_messages: messages.unread,
  };
};

export const SubPortalService = {
  getMe,
  updateMe,
  updateCompany,
  getHome,
  getAssignments,
  getAssignmentById,
  getAssignmentPdf,
  respond,
  reportProgress,
  complete,
  addFiles,
  deleteFile,
  getInvoices,
  getInvoiceById,
  uploadInvoice,
  replaceInvoiceFile,
  getInvoiceFile,
};
