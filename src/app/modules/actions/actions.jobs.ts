import { query } from "../../utils/db";
import { amsterdamToday } from "../../utils/dates";
import { formatMoney } from "../../utils/formatters";
import { SettingsService } from "../settings/settings.service";
import { activeStaffOrNull, createAutomaticAction } from "./actions.shared";

// Automatic tasks that depend on time passing (FR-MSG-04) and the housekeeping that keeps them
// honest. server.ts runs this every morning; an admin can also trigger it with
// POST /actions/jobs/run. It is safe to run as often as you like: a task is made once per event
// (auto_key) and closing only touches tasks whose reason is gone.

const todaySql = `(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Amsterdam')::date`;

// A sent quotation nobody answered (FR-QUO-12). Called by the quote reminder job as well.
const createQuoteFollowUp = async (quote: { id: string; number: string; title: string; relation_name: string; days: number; created_by: string | null }) =>
  createAutomaticAction({
    auto_type: "quote_follow_up",
    auto_key: `quote_follow_up:${quote.id}`,
    title: `Follow up quotation ${quote.number}`,
    description: `${quote.relation_name} has not answered "${quote.title}" for ${quote.days} days. Call or email them.`,
    due_date: amsterdamToday(),
    assignee_id: await activeStaffOrNull(quote.created_by),
    entity: { type: "quote", id: quote.id },
  });

const createQuoteFollowUps = async () => {
  const company = await SettingsService.getCompanySettings();
  const due = await query(
    `
      SELECT q.id, q.number, q.title, q.created_by, r.name AS relation_name,
             GREATEST(0, (${todaySql} - (q.sent_at AT TIME ZONE 'Europe/Amsterdam')::date))::int AS days
      FROM quotes q JOIN relations r ON r.id = q.relation_id
      WHERE q.status = 'SENT' AND q.is_current AND q.sent_at <= CURRENT_TIMESTAMP - make_interval(days => $1)
    `,
    [company.quote_followup_days],
  );
  let created = 0;
  for (const quote of due.rows) {
    if ((await createQuoteFollowUp(quote)).created) created++;
  }
  return created;
};

// An issued invoice past its due date that is still (partly) unpaid
const createOverdueInvoiceActions = async () => {
  const overdue = await query(
    `
      SELECT i.id, i.number, i.created_by, i.customer_name,
             (${todaySql} - i.due_date)::int AS days_past_due,
             (i.total_incl_vat - i.credited_amount - i.paid_amount)::float8 AS open_amount
      FROM invoices i
      WHERE i.status = 'ISSUED' AND i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID')
        AND i.due_date < ${todaySql} AND (i.total_incl_vat - i.credited_amount - i.paid_amount) > 0
    `,
  );
  let created = 0;
  for (const inv of overdue.rows) {
    const result = await createAutomaticAction({
      auto_type: "invoice_overdue",
      auto_key: `invoice_overdue:${inv.id}`,
      title: `Overdue invoice ${inv.number}`,
      description: `${inv.customer_name}: ${inv.days_past_due} day${inv.days_past_due === 1 ? "" : "s"} past the due date, ${formatMoney(inv.open_amount, "EN")} still open.`,
      due_date: amsterdamToday(),
      assignee_id: await activeStaffOrNull(inv.created_by),
      entity: { type: "invoice", id: inv.id },
    });
    if (result.created) created++;
  }
  return created;
};

// Closes automatic tasks whose reason is gone: the invoice was paid or credited, the quotation
// was answered, expired or replaced by a revision
const closeResolvedActions = async () => {
  const note = (text: string) => `Closed automatically: ${text}`;
  const invoices = await query(
    `
      UPDATE actions a SET status = 'DONE', completed_at = CURRENT_TIMESTAMP, completion_note = $1, updated_at = CURRENT_TIMESTAMP
      WHERE a.status = 'OPEN' AND a.auto_type IN ('invoice_overdue', 'direct_debit_failed') AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.id = a.entity_id AND i.status = 'ISSUED' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID')
          AND (i.total_incl_vat - i.credited_amount - i.paid_amount) > 0
      )
      RETURNING a.id
    `,
    [note("the invoice has been paid or credited")],
  );
  const quotes = await query(
    `
      UPDATE actions a SET status = 'DONE', completed_at = CURRENT_TIMESTAMP, completion_note = $1, updated_at = CURRENT_TIMESTAMP
      WHERE a.status = 'OPEN' AND a.auto_type = 'quote_follow_up' AND NOT EXISTS (
        SELECT 1 FROM quotes q WHERE q.id = a.entity_id AND q.status = 'SENT' AND q.is_current
      )
      RETURNING a.id
    `,
    [note("the quotation no longer waits for an answer")],
  );
  return invoices.rows.length + quotes.rows.length;
};

const runScheduledJobs = async () => {
  const closed = await closeResolvedActions();
  return {
    quote_follow_ups: await createQuoteFollowUps(),
    overdue_invoices: await createOverdueInvoiceActions(),
    closed,
  };
};

export const ActionJobs = {
  createQuoteFollowUp,
  createQuoteFollowUps,
  createOverdueInvoiceActions,
  closeResolvedActions,
  runScheduledJobs,
};
