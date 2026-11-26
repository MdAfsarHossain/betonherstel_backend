import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import assertUuid from "../../utils/assertUuid";
import { query } from "../../utils/db";
import { fromCents, lineAmountCents, toCents } from "../../utils/money";
import { calculateTotals, totalsToAmounts } from "../quote/quote.calculation";
import { RelationService } from "../relation/relation.service";
import { TRelationEventType } from "../relation/relation.interface";

// Pieces shared by the invoice services: locking, lines and totals, and the one place that
// works out whether an invoice is open, partly paid, paid or credited.

export const clean = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : (value ?? null);

export const run = (client?: any) => (client ? client.query.bind(client) : query);

export const round2 = (n: number) => Math.round(n * 100) / 100;

// Today in Amsterdam, as SQL
export const todaySql = `(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Amsterdam')::date`;

// Locks the invoice row (a single-table select, never a join) so requests take turns
export const lockInvoice = async (client: any, id: string) => {
  assertUuid(id, "invoice id");
  const result = await client.query(
    `
      SELECT id, number, kind, source, status, payment_status, relation_id, project_id, quote_id, credit_for_id,
             language::text AS language, payment_term_days,
             total_incl_vat::float8 AS total_incl_vat, paid_amount::float8 AS paid_amount,
             credited_amount::float8 AS credited_amount
      FROM invoices WHERE id = $1::uuid FOR UPDATE
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Invoice not found!");
  }
  return result.rows[0];
};

export const logInvoiceEvent = (
  client: any,
  invoice: { id: string; relation_id: string },
  eventType: TRelationEventType,
  title: string,
  actorId: string | null,
  extra: { description?: string | null; metadata?: Record<string, any> } = {},
) =>
  RelationService.logRelationEvent(
    invoice.relation_id,
    {
      event_type: eventType,
      entity_type: "invoice",
      entity_id: invoice.id,
      title,
      description: extra.description ?? null,
      metadata: extra.metadata,
      actor_id: actorId,
    },
    client,
  );

export interface IInvoiceLine {
  section_title?: string | null;
  line_type: "MANUAL" | "QUOTE" | "PROJECT" | "HOURS" | "INSTALMENT" | "DEDUCTION" | "CREDIT";
  catalogue_item_id?: string | null;
  credits_line_id?: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  vat_code: string;
  vat_rate: number;
  vat_reverse_charge: boolean;
}

export const lineTotal = (line: { quantity: number; unit_price: number }) =>
  fromCents(lineAmountCents(line.quantity, toCents(line.unit_price)));

// Appends lines to an invoice (after any it already has)
export const insertLines = async (client: any, invoiceId: string, lines: IInvoiceLine[]) => {
  const next = await client.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM invoice_lines WHERE invoice_id = $1::uuid`,
    [invoiceId],
  );
  let order = Number(next.rows[0].next);
  const ids: string[] = [];
  for (const line of lines) {
    const result = await client.query(
      `
        INSERT INTO invoice_lines (
          invoice_id, sort_order, section_title, line_type, catalogue_item_id, credits_line_id,
          description, quantity, unit, unit_price, vat_code, vat_rate, vat_reverse_charge, line_total
        ) VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
      `,
      [
        invoiceId,
        order++,
        line.section_title ?? null,
        line.line_type,
        line.catalogue_item_id ?? null,
        line.credits_line_id ?? null,
        line.description,
        line.quantity,
        line.unit,
        line.unit_price,
        line.vat_code,
        line.vat_rate,
        line.vat_reverse_charge,
        lineTotal(line),
      ],
    );
    ids.push(result.rows[0].id);
  }
  return ids;
};

const calcLines = (rows: any[]) =>
  rows.map((l) => ({
    quantity: l.quantity,
    unit_price: l.unit_price,
    cost_price: 0,
    vat_code: l.vat_code,
    vat_rate: l.vat_rate,
    vat_reverse_charge: l.vat_reverse_charge,
  }));

// Writes the stored totals from the current lines (VAT once per rate, in cents)
export const recomputeTotals = async (client: any, invoiceId: string) => {
  const lines = await client.query(
    `SELECT quantity::float8 AS quantity, unit_price::float8 AS unit_price, vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge
     FROM invoice_lines WHERE invoice_id = $1::uuid`,
    [invoiceId],
  );
  const totals = calculateTotals(calcLines(lines.rows));
  await client.query(
    `UPDATE invoices SET total_excl_vat = $2, total_vat = $3, total_incl_vat = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
    [invoiceId, fromCents(totals.subtotalCents), fromCents(totals.totalVatCents), fromCents(totals.totalCents)],
  );
  return totals;
};

// Open, partly paid, paid or credited: worked out again from the payments and the issued
// credit notes, so it can never drift from them.
export const recomputePaymentStatus = async (client: any, invoiceId: string) => {
  const invoice = await client.query(
    `SELECT kind, status, total_incl_vat::float8 AS total FROM invoices WHERE id = $1::uuid`,
    [invoiceId],
  );
  const inv = invoice.rows[0];
  if (!inv || inv.kind === "CREDIT_NOTE" || inv.status !== "ISSUED") return null;

  const [paid, credited] = await Promise.all([
    client.query(
      `SELECT COALESCE(SUM(amount), 0)::float8 AS total, MAX(paid_at) AS last FROM invoice_payments WHERE invoice_id = $1::uuid AND reversed_at IS NULL`,
      [invoiceId],
    ),
    client.query(
      `SELECT COALESCE(-SUM(total_incl_vat), 0)::float8 AS total FROM invoices WHERE credit_for_id = $1::uuid AND status = 'ISSUED'`,
      [invoiceId],
    ),
  ]);

  const totalCents = toCents(inv.total);
  const paidCents = toCents(paid.rows[0].total);
  const creditedCents = toCents(credited.rows[0].total);
  const dueCents = totalCents - creditedCents;

  let status: "OPEN" | "PARTIALLY_PAID" | "PAID" | "CREDITED";
  if (creditedCents >= totalCents) status = "CREDITED";
  else if (paidCents >= dueCents) status = "PAID";
  else if (paidCents > 0) status = "PARTIALLY_PAID";
  else status = "OPEN";

  await client.query(
    `
      UPDATE invoices
      SET paid_amount = $2, credited_amount = $3, payment_status = $4::"InvoicePaymentStatus",
          paid_at = CASE WHEN $4::"InvoicePaymentStatus" = 'PAID' THEN $5::timestamptz ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid
    `,
    [invoiceId, fromCents(paidCents), fromCents(creditedCents), status, paid.rows[0].last],
  );

  return {
    status,
    outstanding: fromCents(Math.max(0, dueCents - paidCents)),
    refund_due: fromCents(Math.max(0, paidCents - Math.max(0, dueCents))),
  };
};

// The sections of a document: consecutive lines with the same section title
export const groupSections = (lines: any[]) => {
  const sections: { title: string | null; lines: any[] }[] = [];
  for (const line of lines) {
    const last = sections[sections.length - 1];
    if (last && last.title === (line.section_title ?? null)) last.lines.push(line);
    else sections.push({ title: line.section_title ?? null, lines: [line] });
  }
  return sections;
};

const invoiceColumns = `
  i.id, i.number, i.kind, i.source, i.status, i.payment_status, i.language::text AS language, i.title,
  i.recipient_name, i.recipient_email,
  i.customer_name, i.customer_street, i.customer_house_number, i.customer_postcode, i.customer_city,
  i.customer_country, i.customer_vat_number, i.customer_kvk_number,
  to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
  i.payment_term_days, i.instalment_number, i.instalment_percentage::float8 AS instalment_percentage,
  i.intro_text, i.footer_text, i.internal_notes, i.credit_reason,
  i.total_excl_vat::float8 AS total_excl_vat, i.total_vat::float8 AS total_vat, i.total_incl_vat::float8 AS total_incl_vat,
  i.paid_amount::float8 AS paid_amount, i.credited_amount::float8 AS credited_amount, i.paid_at,
  i.issued_at, iu.name AS issued_by_name, i.sent_at, i.sent_to, (i.pdf_data IS NOT NULL) AS has_pdf,
  i.created_by, i.created_at AS "createdAt", i.updated_at AS "updatedAt",
  (i.status = 'ISSUED' AND i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID') AND i.due_date < ${todaySql}) AS is_overdue,
  CASE WHEN i.status = 'ISSUED' AND i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID') AND i.due_date < ${todaySql}
       THEN (${todaySql} - i.due_date) ELSE 0 END AS days_overdue,
  json_build_object('id', r.id, 'name', r.name, 'type', r.type, 'email', r.email, 'invoice_email', r.invoice_email,
                    'preferred_language', r.preferred_language) AS relation,
  CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'number', p.number, 'title', p.title) END AS project,
  CASE WHEN q.id IS NULL THEN NULL ELSE json_build_object('id', q.id, 'number', q.number) END AS quote,
  CASE WHEN o.id IS NULL THEN NULL ELSE json_build_object('id', o.id, 'number', o.number) END AS credit_for
`;

const invoiceJoins = `
  JOIN relations r ON r.id = i.relation_id
  LEFT JOIN projects p ON p.id = i.project_id
  LEFT JOIN quotes q ON q.id = i.quote_id
  LEFT JOIN invoices o ON o.id = i.credit_for_id
  LEFT JOIN users iu ON iu.id = i.issued_by
`;

export { invoiceColumns, invoiceJoins };

// Everything about one invoice. Pass the transaction's client to read what it just wrote.
export const readInvoice = async (id: string, client?: any) => {
  assertUuid(id, "invoice id");
  const q = run(client);

  const result = await q(`SELECT ${invoiceColumns} FROM invoices i ${invoiceJoins} WHERE i.id = $1::uuid`, [id]);
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Invoice not found!");
  }
  const inv = result.rows[0];

  const [lines, payments, links, reminders, creditNotes] = await Promise.all([
    q(
      `
        SELECT l.id, l.section_title, l.line_type, l.catalogue_item_id, l.credits_line_id, l.description,
               l.quantity::float8 AS quantity, l.unit, l.unit_price::float8 AS unit_price, l.vat_code,
               l.vat_rate::float8 AS vat_rate, l.vat_reverse_charge, l.line_total::float8 AS line_total,
               COALESCE((SELECT SUM(c.quantity) FROM invoice_lines c WHERE c.credits_line_id = l.id), 0)::float8 AS credited_quantity
        FROM invoice_lines l WHERE l.invoice_id = $1::uuid ORDER BY l.sort_order ASC
      `,
      [id],
    ),
    q(
      `
        SELECT p.id, p.amount::float8 AS amount, p.method, p.mollie_payment_id, p.paid_at, p.reference, p.reversed_at, p.reversal_reason,
               u.name AS recorded_by_name, p.created_at AS "createdAt"
        FROM invoice_payments p LEFT JOIN users u ON u.id = p.recorded_by
        WHERE p.invoice_id = $1::uuid ORDER BY p.paid_at ASC, p.created_at ASC
      `,
      [id],
    ),
    q(
      `SELECT id, mollie_payment_id, checkout_url, amount::float8 AS amount, status, kind, failure_reason, created_at AS "createdAt"
       FROM invoice_payment_links WHERE invoice_id = $1::uuid ORDER BY created_at DESC`,
      [id],
    ),
    q(
      `
        SELECT r.id, r.days_after_due, r.kind, r.status, r.sent_to, r.sent_at
        FROM invoice_reminders r WHERE r.invoice_id = $1::uuid ORDER BY r.sent_at ASC
      `,
      [id],
    ),
    q(
      `SELECT id, number, status, total_incl_vat::float8 AS total_incl_vat, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date
       FROM invoices WHERE credit_for_id = $1::uuid ORDER BY created_at ASC`,
      [id],
    ),
  ]);

  const isCredit = inv.kind === "CREDIT_NOTE";
  const detailedLines = lines.rows.map((l: any) => ({
    ...l,
    creditable_quantity: isCredit ? null : round2Q(l.quantity - l.credited_quantity),
  }));
  const calculation = totalsToAmounts(calculateTotals(calcLines(lines.rows)));

  const totalCents = toCents(inv.total_incl_vat);
  const paidCents = toCents(inv.paid_amount);
  const creditedCents = toCents(inv.credited_amount);
  const dueCents = Math.max(0, totalCents - creditedCents);
  const issued = inv.status === "ISSUED";
  const openLink = links.rows.find((l: any) => l.status === "open") ?? null;

  return {
    ...inv,
    customer: {
      name: inv.customer_name,
      street: inv.customer_street,
      house_number: inv.customer_house_number,
      postcode: inv.customer_postcode,
      city: inv.customer_city,
      country: inv.customer_country,
      vat_number: inv.customer_vat_number,
      kvk_number: inv.customer_kvk_number,
    },
    instalment: inv.instalment_number ? { number: inv.instalment_number, percentage: inv.instalment_percentage } : null,
    sections: groupSections(detailedLines),
    calculation,
    payments: payments.rows,
    payment_links: links.rows,
    current_payment_link: openLink ? openLink.checkout_url : null,
    reminders: reminders.rows,
    credit_notes: creditNotes.rows,
    amounts: isCredit
      ? null
      : {
          paid: inv.paid_amount,
          credited: inv.credited_amount,
          outstanding: issued ? fromCents(Math.max(0, dueCents - paidCents)) : null,
          refund_due: issued ? fromCents(Math.max(0, paidCents - dueCents)) : null,
        },
    can_edit: inv.status === "DRAFT",
    can_edit_items: inv.status === "DRAFT" && (inv.source === "MANUAL" || inv.source === "QUOTE"),
    can_credit: issued && !isCredit && detailedLines.some((l: any) => (l.creditable_quantity ?? 0) > 0),
    can_record_payment: issued && !isCredit && inv.payment_status !== "PAID" && inv.payment_status !== "CREDITED",
  };
};

const round2Q = (n: number) => Math.round(n * 1000) / 1000;
