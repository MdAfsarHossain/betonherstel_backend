import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { addDays, amsterdamToday, isValidDay } from "../../utils/dates";
import { query } from "../../utils/db";
import { chatUnreadByProject } from "../chat/chat.shared";
import { ChatService } from "../chat/chat.service";
import { InquiryService } from "../inquiry/inquiry.service";
import { readInvoice } from "../invoice/invoice.shared";
import { InvoicePaymentService } from "../invoice/invoice.payment.service";
import { DirectDebitService } from "../contract/contract.directdebit.service";
import { InvoiceService } from "../invoice/invoice.service";
import { calculateTotals, totalsToAmounts } from "../quote/quote.calculation";
import { QuoteService } from "../quote/quote.service";
import { SettingsService } from "../settings/settings.service";
import {
  clean,
  IPortalUser,
  loadPortalUser,
  round2,
  todaySql,
} from "./portal.shared";

// The customer portal (SRS 4.18). Everything here is for a signed-in customer (role CUSTOMER) and is
// limited to the records of their own relation. What a customer sees is built from explicit columns:
// no cost prices, margins, internal notes, other customers' data or storage keys can leak, because
// they are never selected.

const paged = (rows: any[], total: number, page: number, limit: number) => {
  const totalPage = Math.ceil(total / limit);
  return {
    data: rows,
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

const notFound = (what: string) =>
  new ApiError(httpStatus.NOT_FOUND, `${what} not found!`);

// ---------------------------------------------------------------------------
// Branding and the customer's own details (FR-PORT-10, FR-PORT-12)
// ---------------------------------------------------------------------------

// Public: the login page shows the company's name and logo
const getBranding = async () => {
  const company = await SettingsService.getCompanySettings();
  return {
    company_name: company.company_name,
    logo_url: company.logo_url ?? null,
  };
};

const getMe = async (userId: string) => {
  const user = await loadPortalUser(userId);
  const result = await query(
    `
      SELECT u.id, u.name, u.email, u.phone_number, u.preferred_language::text AS preferred_language, u.last_login_at,
             json_build_object('id', r.id, 'name', r.name, 'type', r.type) AS relation
      FROM users u JOIN relations r ON r.id = u.relation_id WHERE u.id = $1::uuid
    `,
    [user.id],
  );
  return result.rows[0];
};

// Name, phone and language. The email is the login: the office changes it.
const updateMe = async (
  userId: string,
  payload: {
    name?: string;
    phone_number?: string | null;
    preferred_language?: "NL" | "EN";
  },
) => {
  const user = await loadPortalUser(userId);
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
  await query(
    `UPDATE users SET ${updates.join(", ")} WHERE id = $1::uuid`,
    values,
  );
  return getMe(userId);
};

// ---------------------------------------------------------------------------
// Quotations (FR-PORT-04)
// ---------------------------------------------------------------------------

// A customer sees what was sent to them: no drafts, no older revisions
const quoteScope = `q.relation_id = $1::uuid AND q.status <> 'DRAFT' AND q.is_current`;

const quoteListColumns = `
  q.id, q.number, q.revision, q.title, q.status, to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until,
  q.total_excl_vat::float8 AS total_excl_vat, q.total_incl_vat::float8 AS total_incl_vat,
  q.sent_at, q.accepted_at, q.rejected_at,
  (q.status = 'SENT' AND q.valid_until >= ${todaySql}) AS can_respond,
  (SELECT json_build_object('id', pr.id, 'number', pr.number) FROM projects pr WHERE pr.quote_id = q.id LIMIT 1) AS project
`;

const getQuotes = async (userId: string, params: Record<string, any>) => {
  const user = await loadPortalUser(userId);
  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );
  const conditions = [quoteScope];
  const values: any[] = [user.relation_id];
  let n = 2;
  if (params.status) {
    const statuses = String(
      Array.isArray(params.status) ? params.status.join(",") : params.status,
    )
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (
      statuses.some(
        (s) => !["SENT", "ACCEPTED", "REJECTED", "EXPIRED"].includes(s),
      )
    ) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Status should be SENT, ACCEPTED, REJECTED or EXPIRED!",
      );
    }
    conditions.push(`q.status::text = ANY($${n++}::text[])`);
    values.push(statuses);
  }
  const where = conditions.join(" AND ");
  const [rows, count] = await Promise.all([
    query(
      `SELECT ${quoteListColumns} FROM quotes q WHERE ${where} ORDER BY q.sent_at DESC NULLS LAST, q.id DESC LIMIT $${n} OFFSET $${n + 1}`,
      [...values, limit, skip],
    ),
    query(`SELECT COUNT(*)::int AS total FROM quotes q WHERE ${where}`, values),
  ]);
  return paged(rows.rows, count.rows[0].total, page, limit);
};

const loadOwnQuote = async (relationId: string, id: string) => {
  assertUuid(id, "quotation id");
  const found = await query(
    `SELECT q.id FROM quotes q WHERE q.id = $1::uuid AND ${quoteScope.replace("$1::uuid", "$2::uuid")}`,
    [id, relationId],
  );
  if (found.rows.length === 0) throw notFound("Quotation");
};

const getQuoteById = async (userId: string, id: string) => {
  const user = await loadPortalUser(userId);
  await loadOwnQuote(user.relation_id, id);

  const [head, sections, lines] = await Promise.all([
    query(
      `
        SELECT ${quoteListColumns}, q.language::text AS language, q.recipient_name, q.intro_text, q.scope_text, q.conditions_text, q.warranty_text,
               q.accepted_by_name, q.terms_accepted, q.reject_reason,
               q.street, q.house_number, q.postcode, q.city, q.country
        FROM quotes q WHERE q.id = $1::uuid
      `,
      [id],
    ),
    query(
      `SELECT id, title, sort_order FROM quote_sections WHERE quote_id = $1::uuid ORDER BY sort_order ASC`,
      [id],
    ),
    // prices and VAT only: never cost_price or line_cost
    query(
      `
        SELECT id, section_id, description, quantity::float8 AS quantity, unit, unit_price::float8 AS unit_price,
               vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge, line_total::float8 AS line_total
        FROM quote_lines WHERE quote_id = $1::uuid ORDER BY sort_order ASC
      `,
      [id],
    ),
  ]);
  const calc = totalsToAmounts(
    calculateTotals(
      lines.rows.map((l: any) => ({
        quantity: l.quantity,
        unit_price: l.unit_price,
        cost_price: 0,
        vat_code: l.vat_code,
        vat_rate: l.vat_rate,
        vat_reverse_charge: l.vat_reverse_charge,
      })),
    ),
  );
  const { street, house_number, postcode, city, country, ...quote } =
    head.rows[0];
  return {
    ...quote,
    address: street ? { street, house_number, postcode, city, country } : null,
    sections: sections.rows.map((s: any) => ({
      id: s.id,
      title: s.title,
      lines: lines.rows
        .filter((l: any) => l.section_id === s.id)
        .map(({ section_id, ...l }: any) => l),
    })),
    calculation: {
      vat: calc.vat,
      total_excl_vat: calc.total_excl_vat,
      total_vat: calc.total_vat,
      total_incl_vat: calc.total_incl_vat,
    },
  };
};

const getQuotePdf = async (userId: string, id: string) => {
  const user = await loadPortalUser(userId);
  await loadOwnQuote(user.relation_id, id);
  const { buffer, filename } = await QuoteService.getPdf(id);
  return { pdf: buffer as Buffer, filename };
};

// The customer accepts online: name, date and time (now), IP address, and agreement to the terms are
// recorded (FR-PORT-04). The same function the office uses to record an acceptance by phone or email.
const acceptQuote = async (
  userId: string,
  id: string,
  input: { terms_accepted: boolean; accepted_by_name?: string },
  ip: string | undefined,
) => {
  const user = await loadPortalUser(userId);
  await loadOwnQuote(user.relation_id, id);
  await QuoteService.acceptQuote(
    id,
    {
      accepted_by_name: input.accepted_by_name?.trim() || user.name,
      via: "PORTAL",
      terms_accepted: input.terms_accepted,
      ip,
    },
    user.id,
  );
  return getQuoteById(userId, id);
};

const rejectQuote = async (
  userId: string,
  id: string,
  reason: string | null | undefined,
) => {
  const user = await loadPortalUser(userId);
  await loadOwnQuote(user.relation_id, id);
  await QuoteService.rejectQuote(id, clean(reason) ?? undefined, user.id);
  return getQuoteById(userId, id);
};

// ---------------------------------------------------------------------------
// Projects, appointments, documents (FR-PORT-05)
// ---------------------------------------------------------------------------

const projectColumns = `
  p.id, p.number, p.title, p.created_at AS "createdAt", p.closed_at,
  p.street, p.house_number, p.postcode, p.city, p.country,
  json_build_object('key', s.key, 'label_nl', s.label_nl, 'label_en', s.label_en, 'kind', s.kind, 'color', s.color) AS status,
  (SELECT MIN(a.starts_at) FROM appointments a
    WHERE a.project_id = p.id AND a.status = 'PLANNED' AND a.type <> 'INTERNAL' AND a.ends_at >= CURRENT_TIMESTAMP) AS next_appointment
`;

// Unread messages in the project's customer chat, for this person
const withChatUnread = async (
  user: { id: string; relation_id: string },
  rows: any[],
) => {
  const unread = await chatUnreadByProject(
    user.id,
    rows.map((r) => r.id),
    "CUSTOMER",
    user.relation_id,
  );
  return rows.map((r) => ({ ...r, unread_messages: unread.get(r.id) ?? 0 }));
};

const projectJoins = `JOIN project_statuses s ON s.id = p.status_id`;

const shapeProject = (p: any) => {
  const { street, house_number, postcode, city, country, ...rest } = p;
  return {
    ...rest,
    address: street ? { street, house_number, postcode, city, country } : null,
  };
};

const getProjects = async (userId: string, params: Record<string, any>) => {
  const user = await loadPortalUser(userId);
  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );
  const conditions = [`p.relation_id = $1::uuid`];
  if (String(params.active) === "true") conditions.push(`p.closed_at IS NULL`);
  const where = conditions.join(" AND ");
  const [rows, count] = await Promise.all([
    query(
      `SELECT ${projectColumns} FROM projects p ${projectJoins} WHERE ${where} ORDER BY (p.closed_at IS NOT NULL) ASC, p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`,
      [user.relation_id, limit, skip],
    ),
    query(`SELECT COUNT(*)::int AS total FROM projects p WHERE ${where}`, [
      user.relation_id,
    ]),
  ]);
  return paged(
    (await withChatUnread(user, rows.rows)).map(shapeProject),
    count.rows[0].total,
    page,
    limit,
  );
};

const loadOwnProject = async (relationId: string, id: string) => {
  assertUuid(id, "project id");
  const found = await query(
    `SELECT p.id, p.number, p.title, p.project_manager_id FROM projects p WHERE p.id = $1::uuid AND p.relation_id = $2::uuid`,
    [id, relationId],
  );
  if (found.rows.length === 0) throw notFound("Project");
  return found.rows[0];
};

const projectAppointments = (projectOrRelation: "project" | "relation") => `
  SELECT a.id, a.type, a.status::text AS status, a.title, a.starts_at, a.ends_at, a.all_day,
         a.street, a.house_number, a.postcode, a.city, a.country,
         CASE WHEN pj.id IS NULL THEN NULL ELSE json_build_object('id', pj.id, 'number', pj.number, 'title', pj.title) END AS project
  FROM appointments a LEFT JOIN projects pj ON pj.id = a.project_id
  WHERE ${projectOrRelation === "project" ? "a.project_id = $1::uuid" : "(a.relation_id = $1::uuid OR pj.relation_id = $1::uuid)"}
    AND a.type <> 'INTERNAL' AND a.status <> 'CANCELLED'
`;

const shapeAppointment = (a: any) => ({
  id: a.id,
  type: a.type,
  status: a.status,
  title: a.title,
  starts_at: a.starts_at,
  ends_at: a.ends_at,
  all_day: a.all_day,
  address: a.street
    ? {
        street: a.street,
        house_number: a.house_number,
        postcode: a.postcode,
        city: a.city,
        country: a.country,
      }
    : null,
  project: a.project,
});

const getProjectById = async (userId: string, id: string) => {
  const user = await loadPortalUser(userId);
  await loadOwnProject(user.relation_id, id);

  const [head, appointments, files, workOrders, invoices] = await Promise.all([
    query(
      `SELECT ${projectColumns} FROM projects p ${projectJoins} WHERE p.id = $1::uuid`,
      [id],
    ),
    query(`${projectAppointments("project")} ORDER BY a.starts_at ASC`, [id]),
    // only what the office marked as shared with the customer; never the storage key
    query(
      `
        SELECT id, folder, file_name, mime_type, size_bytes, caption, file_url, created_at AS "createdAt"
        FROM project_files WHERE project_id = $1::uuid AND share_with_customer ORDER BY created_at ASC
      `,
      [id],
    ),
    // signed work order PDFs of the project (the matrix: "Signed work order PDFs for own projects")
    query(
      `
        SELECT id, number, title, status, completed_at, signed_by_name
        FROM work_orders WHERE project_id = $1::uuid AND status IN ('COMPLETED', 'CHECKED') AND pdf_data IS NOT NULL ORDER BY completed_at ASC
      `,
      [id],
    ),
    query(
      `
        SELECT id, number, kind, payment_status, to_char(due_date, 'YYYY-MM-DD') AS due_date, total_incl_vat::float8 AS total_incl_vat
        FROM invoices WHERE project_id = $1::uuid AND status = 'ISSUED' ORDER BY issued_at ASC
      `,
      [id],
    ),
  ]);
  return {
    ...shapeProject((await withChatUnread(user, head.rows))[0]),
    appointments: appointments.rows.map(shapeAppointment),
    files: files.rows,
    work_orders: workOrders.rows,
    invoices: invoices.rows,
  };
};

const getWorkOrderPdf = async (userId: string, id: string) => {
  const user = await loadPortalUser(userId);
  assertUuid(id, "work order id");
  const found = await query(
    `
      SELECT w.number, w.pdf_data FROM work_orders w JOIN projects p ON p.id = w.project_id
      WHERE w.id = $1::uuid AND p.relation_id = $2::uuid AND w.status IN ('COMPLETED', 'CHECKED') AND w.pdf_data IS NOT NULL
    `,
    [id, user.relation_id],
  );
  if (found.rows.length === 0) throw notFound("Work order");
  return {
    pdf: found.rows[0].pdf_data as Buffer,
    filename: `${found.rows[0].number}.pdf`,
  };
};

// Upcoming appointments by default (from today); ?from & ?to for another period
const getAppointments = async (userId: string, params: Record<string, any>) => {
  const user = await loadPortalUser(userId);
  const from = params.from ? String(params.from) : amsterdamToday();
  if (!isValidDay(from))
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "from must be a date like 2026-11-30!",
    );
  const values: any[] = [user.relation_id, from];
  let extra = `AND a.ends_at >= ($2::date::timestamp AT TIME ZONE 'Europe/Amsterdam')`;
  if (params.to) {
    const to = String(params.to);
    if (!isValidDay(to))
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "to must be a date like 2026-11-30!",
      );
    values.push(addDays(to, 1));
    extra += ` AND a.starts_at < ($3::date::timestamp AT TIME ZONE 'Europe/Amsterdam')`;
  }
  const result = await query(
    `${projectAppointments("relation")} ${extra} ORDER BY a.starts_at ASC LIMIT 200`,
    values,
  );
  return result.rows.map(shapeAppointment);
};

// ---------------------------------------------------------------------------
// Invoices and payment (FR-PORT-06)
// ---------------------------------------------------------------------------

const invoiceScope = `i.relation_id = $1::uuid AND i.status = 'ISSUED'`;

const invoiceListColumns = `
  i.id, i.number, i.kind, i.title, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
  i.payment_status, i.total_incl_vat::float8 AS total_incl_vat,
  CASE WHEN i.kind = 'CREDIT_NOTE' THEN NULL ELSE GREATEST(0, i.total_incl_vat - i.credited_amount - i.paid_amount)::float8 END AS outstanding,
  (i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID') AND i.due_date < ${todaySql}) AS is_overdue,
  (SELECT json_build_object('id', p.id, 'number', p.number, 'title', p.title) FROM projects p WHERE p.id = i.project_id) AS project
`;

const getInvoices = async (userId: string, params: Record<string, any>) => {
  const user = await loadPortalUser(userId);
  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );
  const conditions = [invoiceScope];
  if (String(params.open) === "true") {
    conditions.push(
      `i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID') AND (i.total_incl_vat - i.credited_amount - i.paid_amount) > 0`,
    );
  }
  const where = conditions.join(" AND ");
  const [rows, count] = await Promise.all([
    query(
      `SELECT ${invoiceListColumns} FROM invoices i WHERE ${where} ORDER BY i.invoice_date DESC, i.id DESC LIMIT $2 OFFSET $3`,
      [user.relation_id, limit, skip],
    ),
    query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(GREATEST(0, i.total_incl_vat - i.credited_amount - i.paid_amount)) FILTER (WHERE i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID')), 0)::float8 AS outstanding
       FROM invoices i WHERE ${where}`,
      [user.relation_id],
    ),
  ]);
  const result = paged(rows.rows, count.rows[0].total, page, limit);
  return {
    ...result,
    totals: { outstanding_incl_vat: round2(count.rows[0].outstanding) },
  };
};

const loadOwnInvoice = async (relationId: string, id: string) => {
  assertUuid(id, "invoice id");
  const found = await query(
    `SELECT i.id FROM invoices i WHERE i.id = $1::uuid AND i.relation_id = $2::uuid AND i.status = 'ISSUED'`,
    [id, relationId],
  );
  if (found.rows.length === 0) throw notFound("Invoice");
};

// Customer-safe: the office's notes, who issued it, reminders and Mollie ids stay out
const getInvoiceById = async (userId: string, id: string) => {
  const user = await loadPortalUser(userId);
  await loadOwnInvoice(user.relation_id, id);
  const inv: any = await readInvoice(id);
  const isCredit = inv.kind === "CREDIT_NOTE";
  const outstanding = inv.amounts?.outstanding ?? null;
  return {
    id: inv.id,
    number: inv.number,
    kind: inv.kind,
    title: inv.title,
    language: inv.language,
    invoice_date: inv.invoice_date,
    due_date: inv.due_date,
    payment_status: inv.payment_status,
    is_overdue: inv.is_overdue,
    days_overdue: inv.days_overdue,
    intro_text: inv.intro_text,
    footer_text: inv.footer_text,
    credit_reason: isCredit ? inv.credit_reason : null,
    customer: inv.customer,
    project: inv.project
      ? {
          id: inv.project.id,
          number: inv.project.number,
          title: inv.project.title,
        }
      : null,
    instalment: inv.instalment,
    sections: (inv.sections ?? []).map((s: any) => ({
      title: s.title,
      lines: (s.lines ?? []).map((l: any) => ({
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unit_price: l.unit_price,
        vat_code: l.vat_code,
        vat_rate: l.vat_rate,
        vat_reverse_charge: l.vat_reverse_charge,
        line_total: l.line_total,
      })),
    })),
    calculation: {
      vat: inv.calculation.vat,
      total_excl_vat: inv.calculation.total_excl_vat,
      total_vat: inv.calculation.total_vat,
      total_incl_vat: inv.calculation.total_incl_vat,
    },
    amounts: isCredit
      ? null
      : {
          paid: inv.amounts.paid,
          credited: inv.amounts.credited,
          outstanding: inv.amounts.outstanding,
        },
    payments: (inv.payments ?? []).map((p: any) => ({
      amount: p.amount,
      method: p.method,
      paid_at: p.paid_at,
    })),
    credit_notes: (inv.credit_notes ?? []).map((c: any) => ({
      number: c.number,
      total_incl_vat: c.total_incl_vat,
      invoice_date: c.invoice_date,
    })),
    can_pay: !isCredit && outstanding !== null && outstanding > 0,
  };
};

const getInvoicePdf = async (userId: string, id: string) => {
  const user = await loadPortalUser(userId);
  await loadOwnInvoice(user.relation_id, id);
  return InvoiceService.getPdf(id);
};

// A Mollie payment for what is still open; the customer is sent to the returned URL
const payInvoice = async (userId: string, id: string) => {
  const user = await loadPortalUser(userId);
  await loadOwnInvoice(user.relation_id, id);
  const link = await InvoicePaymentService.createPaymentLink(id, user.id);
  return { checkout_url: link.url, amount: link.amount };
};

// ---------------------------------------------------------------------------
// Maintenance contracts and direct debit (FR-PORT-07)
// ---------------------------------------------------------------------------

// The customer's own contracts, from explicit columns: no internal notes, no assignees, no staff
const getSubscriptions = async (userId: string) => {
  const user = await loadPortalUser(userId);
  const status = await DirectDebitService.getStatus(user.relation_id);
  const rows = await query(
    `
      SELECT s.id, s.number, s.title, s.description, s.street, s.house_number, s.postcode, s.city, s.country,
             s.amount_excl_vat::float8 AS amount_excl_vat, s.vat_code, s.billing_interval, s.status, s.visits_per_year, s.use_direct_debit,
             to_char(s.start_date, 'YYYY-MM-DD') AS start_date, to_char(s.end_date, 'YYYY-MM-DD') AS end_date,
             to_char(s.next_billing_date, 'YYYY-MM-DD') AS next_billing_date,
             COALESCE((
               SELECT json_agg(json_build_object('id', i.id, 'number', i.number, 'invoice_date', to_char(i.invoice_date, 'YYYY-MM-DD'),
                      'total_incl_vat', i.total_incl_vat::float8, 'payment_status', i.payment_status) ORDER BY i.invoice_date DESC, i.id DESC)
               FROM (SELECT * FROM invoices WHERE subscription_id = s.id AND status = 'ISSUED' ORDER BY invoice_date DESC, id DESC LIMIT 6) i
             ), '[]'::json) AS recent_invoices
      FROM subscriptions s WHERE s.relation_id = $1::uuid ORDER BY s.status = 'ENDED', s.start_date DESC, s.id DESC
    `,
    [user.relation_id],
  );
  const contracts = rows.rows.map((c: any) => ({
    ...c,
    collection:
      c.use_direct_debit && status.active ? "DIRECT_DEBIT" : "PAYMENT_LINK",
  }));
  return {
    direct_debit: {
      active: status.active,
      mandate: status.mandate,
      mollie_connected: status.mollie_connected,
    },
    subscriptions: contracts,
  };
};

const getDirectDebit = async (userId: string) => {
  const user = await loadPortalUser(userId);
  const status = await DirectDebitService.getStatus(user.relation_id);
  return {
    active: status.active,
    mandate: status.mandate,
    mollie_connected: status.mollie_connected,
  };
};

// Set up, or replace, the SEPA direct debit: the customer is sent to Mollie to authorise it
const startDirectDebit = async (userId: string) => {
  const user = await loadPortalUser(userId);
  const result = await DirectDebitService.startSetup(user.relation_id, {
    via: "PORTAL",
    actorId: null,
  });
  return { checkout_url: result.checkout_url };
};

// ---------------------------------------------------------------------------
// Inquiries from the portal (FR-PORT-09)
// ---------------------------------------------------------------------------

const createInquiry = async (
  userId: string,
  input: {
    description: string;
    service_type?: string | null;
    address?: any;
    contact_phone?: string;
  },
) => {
  const user = await loadPortalUser(userId);
  const result = await InquiryService.createInquiry(
    {
      source: "PORTAL",
      relation_id: user.relation_id,
      contact_name: user.name,
      contact_email: user.email,
      contact_phone: input.contact_phone ?? user.phone_number ?? undefined,
      service_type: input.service_type ?? null,
      description: input.description,
      address: input.address ?? null,
      language: user.preferred_language as any,
    },
    null,
  );
  return {
    id: result.inquiry.id,
    reference: result.inquiry.reference,
    created: result.created,
  };
};

const getInquiries = async (userId: string, params: Record<string, any>) => {
  const user = await loadPortalUser(userId);
  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );
  const [rows, count] = await Promise.all([
    query(
      `
        SELECT i.id, i.reference, i.description, i.created_at AS "createdAt",
               json_build_object('key', s.key, 'label_nl', s.label_nl, 'label_en', s.label_en, 'kind', s.kind) AS status,
               CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object('key', st.key, 'label_nl', st.label_nl, 'label_en', st.label_en) END AS service_type
        FROM inquiries i JOIN inquiry_statuses s ON s.id = i.status_id LEFT JOIN service_types st ON st.id = i.service_type_id
        WHERE i.relation_id = $1::uuid ORDER BY i.created_at DESC, i.id DESC LIMIT $2 OFFSET $3
      `,
      [user.relation_id, limit, skip],
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM inquiries WHERE relation_id = $1::uuid`,
      [user.relation_id],
    ),
  ]);
  return paged(rows.rows, count.rows[0].total, page, limit);
};

// One of the customer's own requests, with its photos. Built from explicit
// columns: no assignee, lost reason or internal data.
const loadOwnInquiry = async (relationId: string, id: string) => {
  assertUuid(id, "inquiry id");
  const result = await query(
    `
      SELECT i.id, i.reference, i.description, i.contact_name, i.contact_email, i.contact_phone,
             i.street, i.house_number, i.postcode, i.city, i.country, i.source::text AS source,
             i.created_at AS "createdAt", i.updated_at AS "updatedAt",
             json_build_object('key', s.key, 'label_nl', s.label_nl, 'label_en', s.label_en, 'kind', s.kind) AS status,
             CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object('key', st.key, 'label_nl', st.label_nl, 'label_en', st.label_en) END AS service_type
      FROM inquiries i JOIN inquiry_statuses s ON s.id = i.status_id LEFT JOIN service_types st ON st.id = i.service_type_id
      WHERE i.id = $1::uuid AND i.relation_id = $2::uuid
    `,
    [id, relationId],
  );
  if (result.rows.length === 0) throw notFound("Inquiry");
  return result.rows[0];
};

const getInquiryById = async (userId: string, id: string) => {
  const user = await loadPortalUser(userId);
  const row = await loadOwnInquiry(user.relation_id, id);
  const photos = await query(
    `SELECT id, file_url, file_name, mime_type, size_bytes, created_at AS "createdAt"
     FROM inquiry_photos WHERE inquiry_id = $1::uuid ORDER BY created_at ASC`,
    [id],
  );
  const { source, ...rest } = row;
  return {
    ...rest,
    photos: photos.rows,
    can_edit: source === "PORTAL" && row.status.kind === "OPEN",
  };
};

// The customer can correct a request they sent from the portal while it is
// still open (not won or lost). Only these fields; the office fields stay out.
const updateInquiry = async (
  userId: string,
  id: string,
  input: {
    description?: string;
    service_type?: string | null;
    address?: any;
    contact_phone?: string | null;
  },
) => {
  const user = await loadPortalUser(userId);
  const row = await loadOwnInquiry(user.relation_id, id);
  if (row.source !== "PORTAL")
    throw new ApiError(
      httpStatus.FORBIDDEN,
      "Only requests sent from the portal can be changed here!",
    );
  if (row.status.kind !== "OPEN")
    throw new ApiError(
      httpStatus.CONFLICT,
      "This request is closed and can no longer be changed!",
    );
  await InquiryService.updateInquiry(id, input as any);
  return getInquiryById(userId, id);
};

const addInquiryPhotos = async (userId: string, id: string, files: any[]) => {
  const user = await loadPortalUser(userId);
  assertUuid(id, "inquiry id");
  const found = await query(
    `SELECT id FROM inquiries WHERE id = $1::uuid AND relation_id = $2::uuid AND source::text = 'PORTAL'`,
    [id, user.relation_id],
  );
  if (found.rows.length === 0) throw notFound("Inquiry");
  return InquiryService.addPhotos(id, files, null);
};

// ---------------------------------------------------------------------------
// The home page (FR-PORT-03)
// ---------------------------------------------------------------------------

const getHome = async (userId: string) => {
  const user = await loadPortalUser(userId);
  const rel = user.relation_id;
  const [quotes, projects, appointments, invoices, unread] = await Promise.all([
    query(
      `SELECT ${quoteListColumns} FROM quotes q WHERE ${quoteScope} AND q.status = 'SENT' AND q.valid_until >= ${todaySql} ORDER BY q.valid_until ASC LIMIT 5`,
      [rel],
    ),
    query(
      `SELECT ${projectColumns} FROM projects p ${projectJoins} WHERE p.relation_id = $1::uuid AND p.closed_at IS NULL ORDER BY p.created_at DESC LIMIT 5`,
      [rel],
    ),
    query(
      `${projectAppointments("relation")} AND a.ends_at >= CURRENT_TIMESTAMP ORDER BY a.starts_at ASC LIMIT 5`,
      [rel],
    ),
    query(
      `SELECT ${invoiceListColumns} FROM invoices i WHERE ${invoiceScope} AND i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID') AND (i.total_incl_vat - i.credited_amount - i.paid_amount) > 0 ORDER BY i.due_date ASC LIMIT 5`,
      [rel],
    ),
    ChatService.getUnreadSummary(user.id),
  ]);
  return {
    open_quotations: quotes.rows,
    active_projects: (await withChatUnread(user, projects.rows)).map(
      shapeProject,
    ),
    upcoming_appointments: appointments.rows.map(shapeAppointment),
    open_invoices: invoices.rows,
    unread_messages: unread.unread,
  };
};

export const PortalService = {
  getBranding,
  getMe,
  updateMe,
  getHome,
  getQuotes,
  getQuoteById,
  getQuotePdf,
  acceptQuote,
  rejectQuote,
  getProjects,
  getProjectById,
  getWorkOrderPdf,
  getAppointments,
  getInvoices,
  getInvoiceById,
  getInvoicePdf,
  payInvoice,
  createInquiry,
  getSubscriptions,
  getDirectDebit,
  startDirectDebit,
  getInquiries,
  getInquiryById,
  updateInquiry,
  addInquiryPhotos,
};

export type { IPortalUser };
