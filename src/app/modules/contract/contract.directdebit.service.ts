import httpStatus from "http-status";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import { MollieService } from "../../lib/mollie";
import assertUuid from "../../utils/assertUuid";
import { amsterdamToday } from "../../utils/dates";
import { query } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { formatMoney } from "../../utils/formatters";
import { toLanguage } from "../../utils/i18n";
import { fromCents, toCents } from "../../utils/money";
import { createAutomaticAction } from "../actions/actions.shared";
import { InvoicePaymentService, registerPaymentExtensions } from "../invoice/invoice.payment.service";
import { notify, officeUserIds } from "../messages/notification.shared";
import { RelationService } from "../relation/relation.service";
import { loadCustomer } from "./contract.shared";

// SEPA direct debit through Mollie (FR-ABO-03, FR-ABO-05, FR-PORT-07).
//
// A customer authorises once by paying a very small "first payment" (for example through
// iDEAL). Mollie then holds a SEPA mandate on a Mollie customer. Every later contract invoice
// is collected as a "recurring" payment on that mandate. One Mollie customer and one mandate
// per relation, used for all of its contracts. The CRM keeps only ids and the last four
// characters of the account (NFR-SEC-05).

const SETUP_AMOUNT_CENTS = 1;

const setupStatus = (mollieStatus: string) =>
  ({ paid: "paid", failed: "failed", expired: "expired", canceled: "canceled" } as Record<string, string>)[mollieStatus] ?? "open";

const returnUrl = () => `${config.frontend_url}/portal/subscriptions`;

const recipientOf = (relation: any) => (relation.invoice_email ?? relation.email ?? null) as string | null;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const getStatus = async (relationId: string) => {
  assertUuid(relationId, "relation id");
  const relation = await query(`SELECT type::text AS type FROM relations WHERE id = $1::uuid`, [relationId]);
  if (relation.rows.length === 0) throw new ApiError(httpStatus.NOT_FOUND, "Relation not found!");
  if (!["PRIVATE", "BUSINESS", "VVE"].includes(relation.rows[0].type)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Direct debit is only for customers!");
  }
  const [row, setup, mollie] = await Promise.all([
    query(
      `SELECT mandate_status, mandate_method, consumer_name, consumer_account_hint, updated_at AS "updatedAt"
       FROM relation_direct_debit WHERE relation_id = $1::uuid`,
      [relationId],
    ),
    query(
      `SELECT id, status, requested_via, created_at AS "createdAt"
       FROM direct_debit_setups WHERE relation_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [relationId],
    ),
    MollieService.getConfig(),
  ]);
  const mandate = row.rows[0] ?? null;
  return {
    relation_id: relationId,
    mollie_connected: !!mollie,
    active: mandate?.mandate_status === "valid",
    mandate: mandate
      ? { status: mandate.mandate_status, method: mandate.mandate_method, account_holder: mandate.consumer_name, account: mandate.consumer_account_hint, updatedAt: mandate.updatedAt }
      : null,
    last_setup: setup.rows[0] ?? null,
  };
};

// The mandate to collect with, when there is a valid one
const getValidMandate = async (relationId: string, client?: any) => {
  const run = client ? client.query.bind(client) : query;
  const result = await run(
    `SELECT mollie_customer_id, mandate_id FROM relation_direct_debit
     WHERE relation_id = $1::uuid AND mandate_status = 'valid' AND mandate_id IS NOT NULL`,
    [relationId],
  );
  return result.rows.length > 0 ? { customerId: result.rows[0].mollie_customer_id as string, mandateId: result.rows[0].mandate_id as string } : null;
};

// ---------------------------------------------------------------------------
// Setting up or replacing the mandate
// ---------------------------------------------------------------------------

const ensureCustomer = async (relation: any, forceNew = false) => {
  if (!forceNew) {
    const existing = await query(`SELECT mollie_customer_id FROM relation_direct_debit WHERE relation_id = $1::uuid`, [relation.id]);
    if (existing.rows.length > 0) return existing.rows[0].mollie_customer_id as string;
  }
  const customerId = await MollieService.createCustomer({
    name: relation.name,
    email: recipientOf(relation),
    metadata: { relation_id: relation.id },
  });
  // A new Mollie customer (for example after the API key changed to another account) starts without a mandate
  await query(
    `INSERT INTO relation_direct_debit (relation_id, mollie_customer_id) VALUES ($1::uuid, $2)
     ON CONFLICT (relation_id) DO UPDATE
     SET mollie_customer_id = EXCLUDED.mollie_customer_id, mandate_id = NULL, mandate_status = NULL, mandate_method = NULL,
         consumer_name = NULL, consumer_account_hint = NULL, updated_at = CURRENT_TIMESTAMP`,
    [relation.id, customerId],
  );
  return customerId;
};

// A link the customer opens to authorise (or replace) the direct debit. Returns the Mollie checkout address.
const startSetup = async (relationId: string, options: { via: "OFFICE" | "PORTAL"; actorId: string | null; sendEmail?: boolean }) => {
  const relation = await loadCustomer(relationId);
  if (!(await MollieService.getConfig())) {
    throw new ApiError(httpStatus.CONFLICT, "Mollie is not connected. An admin can add the API key in the settings!");
  }

  const make = async (customerId: string) =>
    MollieService.createFirstPayment({
      customerId,
      amountCents: SETUP_AMOUNT_CENTS,
      description: `Direct debit authorisation ${relation.name}`.slice(0, 255),
      redirectUrl: returnUrl(),
      webhookUrl: InvoicePaymentService.webhookUrl(),
      metadata: { relation_id: relation.id, purpose: "direct_debit_setup" },
    });

  let payment;
  try {
    payment = await make(await ensureCustomer(relation));
  } catch (error: any) {
    // The stored Mollie customer no longer exists in this Mollie account: start over once
    if (error instanceof ApiError && error.statusCode === httpStatus.NOT_FOUND) {
      payment = await make(await ensureCustomer(relation, true));
    } else {
      throw error;
    }
  }

  await query(
    `INSERT INTO direct_debit_setups (relation_id, mollie_payment_id, checkout_url, requested_via, requested_by)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid)`,
    [relation.id, payment.id, payment.checkoutUrl, options.via, options.via === "OFFICE" ? options.actorId : null],
  );

  let emailed: { sent: boolean; to?: string; error?: string } | null = null;
  if (options.sendEmail) {
    const to = recipientOf(relation);
    if (!to) {
      emailed = { sent: false, error: "This customer has no email address" };
    } else {
      try {
        await sendTemplatedEmail({
          to,
          templateKey: "direct_debit_setup",
          language: toLanguage(relation.preferred_language),
          variables: { name: relation.name, link: payment.checkoutUrl },
          related: { type: "relation", id: relation.id },
          sentBy: options.actorId ?? undefined,
        });
        emailed = { sent: true, to };
      } catch (error: any) {
        emailed = { sent: false, to, error: error?.message ?? "Sending failed" };
      }
    }
  }

  return { checkout_url: payment.checkoutUrl as string, mollie_payment_id: payment.id as string, emailed };
};

// Reads the customer's mandates from Mollie and keeps the valid one. A newer valid mandate
// replaces the old one, which is revoked at Mollie.
const syncMandate = async (relationId: string) => {
  const row = await query(`SELECT mollie_customer_id, mandate_id FROM relation_direct_debit WHERE relation_id = $1::uuid`, [relationId]);
  if (row.rows.length === 0) return null;
  const customerId = row.rows[0].mollie_customer_id as string;
  const previous = row.rows[0].mandate_id as string | null;

  const mandates = await MollieService.listMandates(customerId);
  const valid = mandates.filter((m) => m.status === "valid").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const chosen = valid[0] ?? mandates.find((m) => m.status === "pending") ?? null;

  if (!chosen) {
    await query(
      `UPDATE relation_direct_debit SET mandate_id = NULL, mandate_status = 'invalid', updated_at = CURRENT_TIMESTAMP WHERE relation_id = $1::uuid`,
      [relationId],
    );
    return null;
  }

  await query(
    `UPDATE relation_direct_debit
     SET mandate_id = $2, mandate_status = $3, mandate_method = $4, consumer_name = $5, consumer_account_hint = $6, updated_at = CURRENT_TIMESTAMP
     WHERE relation_id = $1::uuid`,
    [relationId, chosen.id, chosen.status, chosen.method, chosen.consumerName, chosen.consumerAccountHint],
  );
  for (const old of valid.slice(1)) await MollieService.revokeMandate(customerId, old.id);

  if (chosen.status === "valid" && chosen.id !== previous) {
    const relation = await query(`SELECT name FROM relations WHERE id = $1::uuid`, [relationId]);
    await RelationService.logRelationEvent(relationId, {
      event_type: "DIRECT_DEBIT_MANDATE_ACTIVE",
      entity_type: "relation",
      entity_id: relationId,
      title: previous ? "Direct debit mandate replaced" : "Direct debit mandate activated",
      metadata: { account: chosen.consumerAccountHint, method: chosen.method },
    });
    await notify(await officeUserIds(), {
      type: "SUBSCRIPTION_UPDATE",
      title: `Direct debit ${previous ? "replaced" : "set up"} by ${relation.rows[0]?.name ?? "a customer"}`,
      entity: { type: "relation", id: relationId },
    });
  }
  return chosen;
};

// Mollie reports the first payment: the customer either authorised or did not
const handleMandatePayment = async (paymentId: string) => {
  const setup = await query(`SELECT id, relation_id FROM direct_debit_setups WHERE mollie_payment_id = $1`, [paymentId]);
  if (setup.rows.length === 0) return false;
  const payment = await MollieService.getPayment(paymentId);
  await query(`UPDATE direct_debit_setups SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [setup.rows[0].id, setupStatus(payment.status)]);
  if (payment.status === "paid") await syncMandate(setup.rows[0].relation_id);
  return true;
};

// For a local server Mollie cannot reach, or a missed webhook: ask Mollie now
const syncSetup = async (relationId: string) => {
  assertUuid(relationId, "relation id");
  const open = await query(`SELECT mollie_payment_id FROM direct_debit_setups WHERE relation_id = $1::uuid AND status = 'open' ORDER BY created_at ASC`, [relationId]);
  for (const row of open.rows) await handleMandatePayment(row.mollie_payment_id);
  await syncMandate(relationId);
  return getStatus(relationId);
};

const revoke = async (relationId: string, actorId: string) => {
  const row = await query(`SELECT mollie_customer_id, mandate_id FROM relation_direct_debit WHERE relation_id = $1::uuid`, [relationId]);
  if (row.rows.length === 0 || !row.rows[0].mandate_id) {
    throw new ApiError(httpStatus.NOT_FOUND, "This customer has no direct debit mandate!");
  }
  await MollieService.revokeMandate(row.rows[0].mollie_customer_id, row.rows[0].mandate_id);
  await query(
    `UPDATE relation_direct_debit SET mandate_id = NULL, mandate_status = 'invalid', updated_at = CURRENT_TIMESTAMP WHERE relation_id = $1::uuid`,
    [relationId],
  );
  await RelationService.logRelationEvent(relationId, {
    event_type: "DIRECT_DEBIT_MANDATE_REVOKED",
    entity_type: "relation",
    entity_id: relationId,
    title: "Direct debit mandate removed",
    actor_id: actorId,
  });
  return getStatus(relationId);
};

// ---------------------------------------------------------------------------
// Collecting an invoice (FR-ABO-02, FR-ABO-03)
// ---------------------------------------------------------------------------

// Starts the direct debit for an issued invoice. The result comes later by webhook.
const collectInvoice = async (invoice: { id: string; number: string; total: number }, mandate: { customerId: string; mandateId: string }) => {
  const payment = await MollieService.createRecurringPayment({
    customerId: mandate.customerId,
    mandateId: mandate.mandateId,
    amountCents: toCents(invoice.total),
    description: `Invoice ${invoice.number}`,
    webhookUrl: InvoicePaymentService.webhookUrl(),
    metadata: { invoice_id: invoice.id, invoice_number: invoice.number },
  });
  await query(
    `INSERT INTO invoice_payment_links (invoice_id, mollie_payment_id, checkout_url, amount, status, kind)
     VALUES ($1::uuid, $2, $3, $4, $5, 'DIRECT_DEBIT')`,
    [invoice.id, payment.id, InvoicePaymentService.portalUrl(invoice.id), fromCents(toCents(invoice.total)), payment.status === "pending" ? "pending" : "open"],
  );
  return payment;
};

// ---------------------------------------------------------------------------
// A direct debit failed or was reversed (FR-ABO-05)
// ---------------------------------------------------------------------------

// Flag it (a task and a dashboard warning), tell the office, and give the customer a payment link
// `sendLink: false` when the invoice email (with its own payment link) goes out anyway
const handleFailure = async (event: { invoiceId: string; linkId: string; reason: string | null; reversed: boolean; sendLink?: boolean }) => {
  const found = await query(
    `
      SELECT i.id, i.number, i.relation_id, i.language::text AS language, i.recipient_name, i.recipient_email,
             i.total_incl_vat::float8 AS total, i.paid_amount::float8 AS paid, i.credited_amount::float8 AS credited,
             r.name AS relation_name, r.invoice_email, r.email AS relation_email
      FROM invoices i JOIN relations r ON r.id = i.relation_id WHERE i.id = $1::uuid
    `,
    [event.invoiceId],
  );
  if (found.rows.length === 0) return;
  const inv = found.rows[0];
  const outstandingCents = Math.max(0, toCents(inv.total) - toCents(inv.credited) - toCents(inv.paid));
  if (outstandingCents <= 0) return;

  const language = toLanguage(inv.language);
  const reason = event.reason ?? (event.reversed ? "reversed by the bank" : "the bank refused it");
  const title = `Direct debit ${event.reversed ? "reversed" : "failed"}: invoice ${inv.number}`;

  await createAutomaticAction({
    auto_type: "direct_debit_failed",
    auto_key: `direct_debit_failed:${event.linkId}`,
    title,
    description: `${inv.relation_name}: ${formatMoney(fromCents(outstandingCents), "EN")} could not be collected (${reason}). The customer was sent a payment link.`,
    due_date: amsterdamToday(),
    entity: { type: "invoice", id: inv.id },
  });
  await notify(await officeUserIds(), {
    type: "SUBSCRIPTION_UPDATE",
    title,
    body: `${inv.relation_name}: ${reason}`,
    entity: { type: "invoice", id: inv.id },
  });
  await RelationService.logRelationEvent(inv.relation_id, {
    event_type: "DIRECT_DEBIT_FAILED",
    entity_type: "invoice",
    entity_id: inv.id,
    title,
    metadata: { reason, reversed: event.reversed },
  });

  // Follow up with a payment link. A failing email never undoes the flag above.
  if (event.sendLink === false) return;
  try {
    const to = (inv.recipient_email ?? inv.invoice_email ?? inv.relation_email) as string | null;
    if (!to) return;
    const link = await InvoicePaymentService.createPaymentLink(inv.id, null);
    await sendTemplatedEmail({
      to,
      templateKey: "direct_debit_failed",
      language,
      variables: { name: inv.recipient_name ?? inv.relation_name, invoice_number: inv.number, amount: formatMoney(fromCents(outstandingCents), language), reason, payment_link: link.url },
      related: { type: "invoice", id: inv.id },
    });
  } catch (error: any) {
    console.error(`❌ Could not send the payment link for invoice ${inv.number}:`, error?.message ?? error);
  }
};

registerPaymentExtensions({ onMandatePayment: handleMandatePayment, onDirectDebitFailure: handleFailure });

export const DirectDebitService = {
  getStatus,
  getValidMandate,
  startSetup,
  syncSetup,
  syncMandate,
  revoke,
  collectInvoice,
  handleMandatePayment,
  handleFailure,
};
