import { MollieService } from "../../lib/mollie";
import { addDays, amsterdamToday } from "../../utils/dates";
import { query } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { formatDate, formatMoney } from "../../utils/formatters";
import { toLanguage } from "../../utils/i18n";
import { InvoiceDeliveryService } from "../invoice/invoice.delivery.service";
import { InvoicePaymentService } from "../invoice/invoice.payment.service";
import { InvoiceService } from "../invoice/invoice.service";
import { notify, officeUserIds } from "../messages/notification.shared";
import { PlanningService } from "../planning/planning.service";
import { DirectDebitService } from "./contract.directdebit.service";
import { lastDayOfPeriod, loadContract, logContractEvent, nextBillingDate, periodLabel, visitDatesBetween } from "./contract.shared";

// The scheduled work of the maintenance contracts: billing on each billing date (FR-ABO-02) and
// planning the maintenance visits (FR-ABO-06). Both are safe to repeat: a billed period and a
// planned visit are each claimed by a unique row, so a rerun, a crash or two servers never make
// an invoice or an appointment twice.

const VISIT_LEAD_DAYS = 45;
const STALE_CLAIM_MINUTES = 15;

type TBillResult = "BILLED" | "ENDED" | "NOT_DUE" | "FAILED";

const markEndedIfDone = async (id: string) =>
  query(
    `UPDATE subscriptions SET status = 'ENDED', ended_at = CURRENT_TIMESTAMP, next_billing_date = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1::uuid AND status = 'ACTIVE'`,
    [id],
  );

const advance = async (id: string, next: string, endDate: string | null) => {
  if (endDate && next > endDate) {
    await markEndedIfDone(id);
    return true;
  }
  await query(`UPDATE subscriptions SET next_billing_date = $2::date, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id, next]);
  return false;
};

// ---------------------------------------------------------------------------
// Collecting a freshly issued contract invoice (FR-ABO-03, FR-ABO-04, FR-ABO-05)
// ---------------------------------------------------------------------------

const sendDirectDebitNotice = async (invoiceId: string) => {
  const found = await query(
    `
      SELECT i.id, i.number, i.language::text AS language, i.recipient_name, i.recipient_email, i.pdf_data,
             to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.total_incl_vat::float8 AS total,
             r.name AS relation_name, r.invoice_email, r.email AS relation_email
      FROM invoices i JOIN relations r ON r.id = i.relation_id WHERE i.id = $1::uuid
    `,
    [invoiceId],
  );
  const inv = found.rows[0];
  const to = (inv.recipient_email ?? inv.invoice_email ?? inv.relation_email) as string | null;
  if (!to) throw new Error("There is no email address to send this to");
  const language = toLanguage(inv.language);
  await sendTemplatedEmail({
    to,
    templateKey: "invoice_direct_debit",
    language,
    variables: {
      name: inv.recipient_name ?? inv.relation_name,
      invoice_number: inv.number,
      total: formatMoney(inv.total, language),
      due_date: formatDate(`${inv.due_date}T12:00:00Z`, language),
      link: InvoicePaymentService.portalUrl(inv.id),
    },
    attachments: [{ filename: `${inv.number}.pdf`, content: inv.pdf_data, contentType: "application/pdf" }],
    related: { type: "invoice", id: inv.id },
  });
  await query(`UPDATE invoices SET sent_at = CURRENT_TIMESTAMP, sent_to = $2 WHERE id = $1::uuid`, [invoiceId, to]);
};

const collect = async (invoiceId: string, contract: any): Promise<"DIRECT_DEBIT" | "PAYMENT_LINK"> => {
  const invoice = (await query(`SELECT id, number, total_incl_vat::float8 AS total FROM invoices WHERE id = $1::uuid`, [invoiceId])).rows[0];

  if (contract.use_direct_debit) {
    const mandate = await DirectDebitService.getValidMandate(contract.relation_id);
    if (mandate && (await MollieService.getConfig())) {
      try {
        await DirectDebitService.collectInvoice(invoice, mandate);
        try {
          await sendDirectDebitNotice(invoiceId);
        } catch (error: any) {
          console.error(`❌ Direct debit notice for ${invoice.number} was not sent:`, error?.message ?? error);
          await notify(await officeUserIds(), {
            type: "SUBSCRIPTION_UPDATE",
            title: `Invoice ${invoice.number} could not be emailed`,
            body: error?.message ?? "Sending failed",
            entity: { type: "invoice", id: invoiceId },
          });
        }
        return "DIRECT_DEBIT";
      } catch (error: any) {
        // Mollie refused the collection (revoked mandate, outage): the customer gets a payment link instead
        console.error(`❌ Direct debit for ${invoice.number} could not be started:`, error?.message ?? error);
        await DirectDebitService.handleFailure({
          invoiceId,
          linkId: `start:${invoiceId}`,
          reason: error?.message ?? "the direct debit could not be started",
          reversed: false,
          sendLink: false,
        });
      }
    }
  }

  try {
    await InvoiceDeliveryService.sendInvoice(invoiceId, undefined, null);
  } catch (error: any) {
    console.error(`❌ Invoice ${invoice.number} was not sent:`, error?.message ?? error);
    await notify(await officeUserIds(), {
      type: "SUBSCRIPTION_UPDATE",
      title: `Invoice ${invoice.number} could not be sent`,
      body: error?.message ?? "Sending failed",
      entity: { type: "invoice", id: invoiceId },
    });
  }
  return "PAYMENT_LINK";
};

// ---------------------------------------------------------------------------
// Billing (FR-ABO-02)
// ---------------------------------------------------------------------------

const billOne = async (id: string): Promise<TBillResult> => {
  const c = await loadContract(id);
  const today = amsterdamToday();
  if (c.status !== "ACTIVE" || !c.next_billing_date || c.next_billing_date > today) return "NOT_DUE";

  // Billing dates after the end date are never billed
  if (c.end_date && c.next_billing_date > c.end_date) {
    await markEndedIfDone(id);
    return "ENDED";
  }

  // A whole period or more behind (the server was off, or the start date was in the past):
  // earlier periods are recorded as skipped and only the current one is billed, so a customer is
  // never hit with a flood of invoices
  let start: string = c.next_billing_date;
  for (let i = 0; i < 1200 && nextBillingDate(start, c.billing_interval, c.anchor_day) <= today; i++) {
    const period = { start, end: lastDayOfPeriod(start, c.billing_interval, c.anchor_day) };
    await query(
      `INSERT INTO subscription_billings (subscription_id, period_start, period_end, status) VALUES ($1::uuid, $2::date, $3::date, 'SKIPPED')
       ON CONFLICT (subscription_id, period_start) DO NOTHING`,
      [id, period.start, period.end],
    );
    start = nextBillingDate(start, c.billing_interval, c.anchor_day);
    if (c.end_date && start > c.end_date) {
      await advance(id, start, c.end_date);
      return "ENDED";
    }
  }
  const periodEnd = lastDayOfPeriod(start, c.billing_interval, c.anchor_day);
  const next = nextBillingDate(start, c.billing_interval, c.anchor_day);

  // Claim the period: the unique key means only one run can bill it
  const claim = await query(
    `INSERT INTO subscription_billings (subscription_id, period_start, period_end, status) VALUES ($1::uuid, $2::date, $3::date, 'CLAIMED')
     ON CONFLICT (subscription_id, period_start) DO NOTHING RETURNING id`,
    [id, start, periodEnd],
  );
  if (claim.rows.length === 0) {
    const existing = (await query(`SELECT id, status, invoice_id, created_at < CURRENT_TIMESTAMP - make_interval(mins => $3::int) AS stale
                                   FROM subscription_billings WHERE subscription_id = $1::uuid AND period_start = $2::date`, [id, start, STALE_CLAIM_MINUTES])).rows[0];
    if (existing?.status === "CLAIMED" && !existing.invoice_id && existing.stale) {
      // A run that died before making the invoice: free the period so the next run bills it
      await query(`DELETE FROM subscription_billings WHERE id = $1::uuid`, [existing.id]);
      return "FAILED";
    }
    if (existing && existing.status !== "CLAIMED") await advance(id, next, c.end_date);
    return "NOT_DUE";
  }
  const billingId = claim.rows[0].id as string;

  let invoiceId: string | null = null;
  try {
    const label = periodLabel(start, periodEnd);
    const where = c.street ? ` Object: ${c.street} ${c.house_number}, ${c.postcode} ${c.city}.` : "";
    const draft: any = await InvoiceService.createInvoice(
      {
        source: "MANUAL",
        relation_id: c.relation_id,
        title: `${c.title} (${label})`,
        language: c.language,
        payment_term_days: c.payment_term_days,
        intro_text: `Maintenance contract ${c.number}, period ${label}.${where}`,
        sections: [
          {
            title: c.number,
            lines: [{ description: `${c.title} (${label})`, quantity: 1, unit: "lump_sum", unit_price: c.amount_excl_vat, vat_code: c.vat_code }],
          },
        ],
      } as any,
      null as any,
    );
    invoiceId = draft.id as string;
    await query(`UPDATE invoices SET subscription_id = $2::uuid WHERE id = $1::uuid`, [invoiceId, id]);
    await InvoiceService.issueInvoice(invoiceId, { send: false }, null as any);
  } catch (error: any) {
    console.error(`❌ Billing contract ${c.number} (${start}) failed:`, error?.message ?? error);
    // Undo what was started so the next run can try again
    if (invoiceId) {
      await InvoiceService.deleteInvoice(invoiceId, null as any).catch(() => undefined);
    }
    await query(`DELETE FROM subscription_billings WHERE id = $1::uuid AND status = 'CLAIMED'`, [billingId]);
    await notify(await officeUserIds(), {
      type: "SUBSCRIPTION_UPDATE",
      title: `Billing contract ${c.number} failed`,
      body: error?.message ?? "Unknown error",
      entity: { type: "subscription", id },
    });
    return "FAILED";
  }

  // The invoice exists and is issued: record it and move the contract on before anything that can fail
  await query(`UPDATE subscription_billings SET status = 'ISSUED', invoice_id = $2::uuid WHERE id = $1::uuid`, [billingId, invoiceId]);
  await advance(id, next, c.end_date);
  await logContractEvent(c, "SUBSCRIPTION_INVOICED", `Invoice made for contract ${c.number}, period ${periodLabel(start, periodEnd)}`, null, { invoice_id: invoiceId, period_start: start, period_end: periodEnd });

  const collection = await collect(invoiceId as string, c);
  await query(`UPDATE subscription_billings SET collection = $2 WHERE id = $1::uuid`, [billingId, collection]);
  return "BILLED";
};

// Bills every active contract whose billing date has come
const runBilling = async (onlyId?: string) => {
  const today = amsterdamToday();
  const due = await query(
    `SELECT id FROM subscriptions WHERE status = 'ACTIVE' AND next_billing_date <= $1::date ${onlyId ? "AND id = $2::uuid" : ""} ORDER BY next_billing_date ASC, id ASC`,
    onlyId ? [today, onlyId] : [today],
  );
  const result = { billed: 0, ended: 0, failed: 0 };
  for (const row of due.rows) {
    try {
      const r = await billOne(row.id);
      if (r === "BILLED") result.billed++;
      else if (r === "ENDED") result.ended++;
      else if (r === "FAILED") result.failed++;
    } catch (error: any) {
      result.failed++;
      console.error(`❌ Billing of contract ${row.id} crashed:`, error?.message ?? error);
    }
  }
  return result;
};

// A contract whose end date has passed and has nothing left to bill is finished
const endFinishedContracts = async () => {
  const done = await query(
    `UPDATE subscriptions SET status = 'ENDED', ended_at = CURRENT_TIMESTAMP, next_billing_date = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'ACTIVE' AND end_date IS NOT NULL AND (next_billing_date IS NULL OR next_billing_date > end_date) RETURNING id`,
  );
  return done.rows.length;
};

// ---------------------------------------------------------------------------
// Maintenance visits (FR-ABO-06)
// ---------------------------------------------------------------------------

// Visits are planned VISIT_LEAD_DAYS ahead as all-day maintenance appointments the office can
// then give a time and a crew. A visit date is claimed once (unique key), so reruns never double book.
const createVisits = async () => {
  const today = amsterdamToday();
  const horizon = addDays(today, VISIT_LEAD_DAYS);
  const contracts = await query(
    `SELECT id FROM subscriptions WHERE status = 'ACTIVE' AND visits_per_year > 0 AND first_visit_date IS NOT NULL`,
  );

  let created = 0;
  for (const row of contracts.rows) {
    const c = await loadContract(row.id);
    const from = c.start_date > today ? c.start_date : today;
    const to = c.end_date && c.end_date < horizon ? c.end_date : horizon;
    for (const date of visitDatesBetween(c.first_visit_date, c.visits_per_year, from, to)) {
      const claim = await query(
        `INSERT INTO subscription_visits (subscription_id, visit_date) VALUES ($1::uuid, $2::date) ON CONFLICT (subscription_id, visit_date) DO NOTHING RETURNING id`,
        [c.id, date],
      );
      if (claim.rows.length === 0) continue;
      try {
        const range = (
          await query(`SELECT ($1::date)::timestamp AT TIME ZONE 'Europe/Amsterdam' AS s, ($1::date + 1)::timestamp AT TIME ZONE 'Europe/Amsterdam' AS e`, [date])
        ).rows[0];
        const appointment: any = await PlanningService.createAppointment(
          {
            type: "MAINTENANCE",
            title: `Maintenance visit - ${c.title}`,
            starts_at: new Date(range.s).toISOString(),
            ends_at: new Date(range.e).toISOString(),
            all_day: true,
            relation_id: c.relation_id,
            address: c.street ? { street: c.street, house_number: c.house_number, postcode: c.postcode, city: c.city, country: c.country } : undefined,
            notes: `Maintenance contract ${c.number}`,
            assignee_ids: c.visit_assignee_ids ?? [],
          } as any,
          null as any,
        );
        await query(`UPDATE subscription_visits SET appointment_id = $2::uuid WHERE id = $1::uuid`, [claim.rows[0].id, appointment.id]);
        await logContractEvent(c, "SUBSCRIPTION_VISIT_PLANNED", `Maintenance visit planned for ${date}`, null, { appointment_id: appointment.id, visit_date: date });
        created++;
      } catch (error: any) {
        // Free the date so the next run tries again, and tell the office
        console.error(`❌ Visit for contract ${c.number} on ${date} failed:`, error?.message ?? error);
        await query(`DELETE FROM subscription_visits WHERE id = $1::uuid`, [claim.rows[0].id]);
        await notify(await officeUserIds(), {
          type: "SUBSCRIPTION_UPDATE",
          title: `Maintenance visit for contract ${c.number} could not be planned`,
          body: error?.message ?? "Unknown error",
          entity: { type: "subscription", id: c.id },
        });
      }
    }
  }
  return created;
};

const runScheduledJobs = async () => {
  const billing = await runBilling();
  const ended = await endFinishedContracts();
  const visits = await createVisits();
  return { ...billing, ended: billing.ended + ended, visits_planned: visits };
};

export const ContractJobs = { runBilling, billOne, createVisits, endFinishedContracts, runScheduledJobs };
