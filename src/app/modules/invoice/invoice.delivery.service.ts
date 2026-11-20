import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { MollieService } from "../../lib/mollie";
import assertUuid from "../../utils/assertUuid";
import { query, transaction } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { formatDate, formatMoney } from "../../utils/formatters";
import { toLanguage } from "../../utils/i18n";
import { fromCents, toCents } from "../../utils/money";
import { SettingsService } from "../settings/settings.service";
import { InvoicePaymentService } from "./invoice.payment.service";
import { clean, logInvoiceEvent, readInvoice, todaySql } from "./invoice.shared";

// Getting the invoice to the customer (FR-INV-07) and chasing payment (FR-INV-11).

const loadForDelivery = async (id: string) => {
  assertUuid(id, "invoice id");
  const found = await query(
    `
      SELECT i.id, i.number, i.kind, i.status, i.payment_status, i.relation_id, i.language::text AS language,
             i.recipient_name, i.recipient_email, i.pdf_data,
             to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
             i.total_incl_vat::float8 AS total, i.paid_amount::float8 AS paid, i.credited_amount::float8 AS credited,
             r.invoice_email, r.email AS relation_email, r.name AS relation_name,
             o.number AS original_number
      FROM invoices i
      JOIN relations r ON r.id = i.relation_id
      LEFT JOIN invoices o ON o.id = i.credit_for_id
      WHERE i.id = $1::uuid
    `,
    [id],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Invoice not found!");
  }
  const inv = found.rows[0];
  if (inv.status !== "ISSUED" || !inv.pdf_data) {
    throw new ApiError(httpStatus.CONFLICT, "Only an issued invoice can be sent. Issue it first!");
  }
  const outstandingCents = Math.max(0, toCents(inv.total) - toCents(inv.credited) - toCents(inv.paid));
  return { inv, outstandingCents };
};

const recipientOf = (inv: any, override?: string) => {
  const to = clean(override)?.toLowerCase() ?? inv.recipient_email ?? inv.invoice_email ?? inv.relation_email ?? null;
  if (!to) {
    throw new ApiError(httpStatus.BAD_REQUEST, "There is no email address to send this to!");
  }
  return to as string;
};

// A fresh Mollie link when Mollie is connected; otherwise the portal page (the PDF says how to pay)
const paymentLinkFor = async (inv: any, outstandingCents: number, actorId: string | null) => {
  if (outstandingCents > 0 && (await MollieService.getConfig())) {
    // If Mollie is connected but fails, the email is not sent without its link
    return (await InvoicePaymentService.createPaymentLink(inv.id, actorId)).url as string;
  }
  return InvoicePaymentService.portalUrl(inv.id);
};

// Emails the issued invoice (or credit note) with its PDF and, where something is open, a
// Mollie payment link. Marked as sent only once the email has really gone out.
const sendInvoice = async (id: string, emailOverride: string | undefined, actorId: string | null) => {
  const { inv, outstandingCents } = await loadForDelivery(id);
  const to = recipientOf(inv, emailOverride);
  const language = toLanguage(inv.language);
  const isCredit = inv.kind === "CREDIT_NOTE";
  const link = isCredit ? InvoicePaymentService.portalUrl(inv.id) : await paymentLinkFor(inv, outstandingCents, actorId);
  const name = inv.recipient_name ?? inv.relation_name;

  await sendTemplatedEmail({
    to,
    templateKey: isCredit ? "credit_note" : "invoice",
    language,
    variables: isCredit
      ? {
          name,
          credit_note_number: inv.number,
          total: formatMoney(Math.abs(inv.total), language),
          original_number: inv.original_number ?? "",
          link,
        }
      : {
          name,
          invoice_number: inv.number,
          total: formatMoney(inv.total, language),
          due_date: formatDate(`${inv.due_date}T12:00:00Z`, language),
          payment_link: link,
          link: InvoicePaymentService.portalUrl(inv.id),
        },
    attachments: [{ filename: `${inv.number}.pdf`, content: inv.pdf_data, contentType: "application/pdf" }],
    related: { type: "invoice", id: inv.id },
    sentBy: actorId ?? undefined,
  });

  await transaction(async (client) => {
    await client.query(`UPDATE invoices SET sent_at = CURRENT_TIMESTAMP, sent_to = $2 WHERE id = $1::uuid`, [id, to]);
    await logInvoiceEvent(
      client,
      { id, relation_id: inv.relation_id },
      isCredit ? "CREDIT_NOTE_SENT" : "INVOICE_SENT",
      `${isCredit ? "Credit note" : "Invoice"} ${inv.number} sent to ${to}`,
      actorId,
    );
  });

  return { sent_to: to, payment_link: isCredit ? null : link };
};

// ---------------------------------------------------------------------------
// Reminders (FR-INV-11)
// ---------------------------------------------------------------------------

// A reminder with a fresh payment link for what is still open. `daysAfterDue` is the step
// of the schedule it belongs to (7, 14, 30 days...); a reminder sent by hand has none.
const sendReminder = async (id: string, options: { daysAfterDue: number | null; email?: string }, actorId: string | null) => {
  const { inv, outstandingCents } = await loadForDelivery(id);
  if (inv.kind === "CREDIT_NOTE") {
    throw new ApiError(httpStatus.CONFLICT, "A credit note cannot be reminded!");
  }
  if (!["OPEN", "PARTIALLY_PAID"].includes(inv.payment_status) || outstandingCents <= 0) {
    throw new ApiError(httpStatus.CONFLICT, "Nothing is open on this invoice, so there is nothing to remind!");
  }
  const to = recipientOf(inv, options.email);
  const language = toLanguage(inv.language);
  const automatic = options.daysAfterDue !== null;

  // An automatic step is claimed first, so two runs at the same moment never remind twice
  let claimId: string | null = null;
  if (automatic) {
    const claim = await query(
      `
        INSERT INTO invoice_reminders (invoice_id, days_after_due, kind, status, sent_to, created_by)
        VALUES ($1::uuid, $2, 'AUTOMATIC', 'SENT', $3, $4::uuid)
        ON CONFLICT (invoice_id, days_after_due) DO NOTHING
        RETURNING id
      `,
      [id, options.daysAfterDue, to, actorId],
    );
    if (claim.rows.length === 0) return { sent: false as const };
    claimId = claim.rows[0].id;
  }

  try {
    const link = await paymentLinkFor(inv, outstandingCents, actorId);
    await sendTemplatedEmail({
      to,
      templateKey: "invoice_reminder",
      language,
      variables: {
        name: inv.recipient_name ?? inv.relation_name,
        invoice_number: inv.number,
        total: formatMoney(fromCents(outstandingCents), language),
        due_date: formatDate(`${inv.due_date}T12:00:00Z`, language),
        payment_link: link,
      },
      attachments: [{ filename: `${inv.number}.pdf`, content: inv.pdf_data, contentType: "application/pdf" }],
      related: { type: "invoice", id: inv.id },
      sentBy: actorId ?? undefined,
    });
  } catch (error) {
    // Not sent: free the step so the next run tries again
    if (claimId) await query(`DELETE FROM invoice_reminders WHERE id = $1::uuid`, [claimId]);
    throw error;
  }

  await transaction(async (client) => {
    if (!claimId) {
      await client.query(
        `INSERT INTO invoice_reminders (invoice_id, days_after_due, kind, status, sent_to, created_by) VALUES ($1::uuid, NULL, 'MANUAL', 'SENT', $2, $3::uuid)`,
        [id, to, actorId],
      );
    }
    await logInvoiceEvent(
      client,
      { id, relation_id: inv.relation_id },
      "INVOICE_REMINDER_SENT",
      `Payment reminder for invoice ${inv.number} sent to ${to}`,
      actorId,
      { metadata: { days_after_due: options.daysAfterDue } },
    );
  });

  return { sent: true as const, sent_to: to };
};

const remindInvoice = async (id: string, email: string | undefined, actorId: string) => {
  await sendReminder(id, { daysAfterDue: null, email }, actorId);
  return readInvoice(id);
};

// ---------------------------------------------------------------------------
// The scheduled job
// ---------------------------------------------------------------------------

// Runs daily (server.ts) or on demand (POST /invoices/jobs/run). For every overdue invoice
// it looks at the schedule (company settings: e.g. 7, 14 and 30 days after the due date)
// and sends the latest step that has come up and was not sent yet. Steps that were passed
// over (the job did not run for a while) are marked skipped, not sent as a flood.
const sendDueReminders = async () => {
  const company = await SettingsService.getCompanySettings();
  const steps: number[] = [...(company.reminder_days_after_due ?? [])].sort((a, b) => a - b);
  if (steps.length === 0) return 0;

  const overdue = await query(
    `
      SELECT id, (${todaySql} - due_date)::int AS days_past_due
      FROM invoices
      WHERE status = 'ISSUED' AND kind <> 'CREDIT_NOTE' AND payment_status IN ('OPEN', 'PARTIALLY_PAID')
        AND due_date < ${todaySql} AND (total_incl_vat - credited_amount - paid_amount) > 0
        AND NOT EXISTS (SELECT 1 FROM invoice_payment_links pl WHERE pl.invoice_id = invoices.id AND pl.kind = 'DIRECT_DEBIT' AND pl.status = 'pending')
    `,
  );

  let sent = 0;
  for (const row of overdue.rows) {
    const reached = steps.filter((d) => d <= row.days_past_due);
    if (reached.length === 0) continue;

    const done = await query(`SELECT days_after_due FROM invoice_reminders WHERE invoice_id = $1::uuid AND days_after_due IS NOT NULL`, [row.id]);
    const doneSteps = new Set<number>(done.rows.map((r: any) => r.days_after_due));
    const pending = reached.filter((d) => !doneSteps.has(d));
    if (pending.length === 0) continue;

    const latest = Math.max(...pending);
    try {
      const result = await sendReminder(row.id, { daysAfterDue: latest }, null);
      if (!result.sent) continue;
      sent++;
      for (const skipped of pending.filter((d) => d < latest)) {
        await query(
          `INSERT INTO invoice_reminders (invoice_id, days_after_due, kind, status) VALUES ($1::uuid, $2, 'AUTOMATIC', 'SKIPPED') ON CONFLICT DO NOTHING`,
          [row.id, skipped],
        );
      }
    } catch (error: any) {
      console.error(`❌ Reminder for invoice ${row.id} failed:`, error?.message ?? error);
    }
  }
  return sent;
};

export const InvoiceDeliveryService = { sendInvoice, remindInvoice, sendReminder, sendDueReminders };
