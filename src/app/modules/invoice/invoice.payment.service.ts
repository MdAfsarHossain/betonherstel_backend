import httpStatus from "http-status";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import { MollieService, IMolliePayment } from "../../lib/mollie";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { query, transaction } from "../../utils/db";
import { formatMoney } from "../../utils/formatters";
import { fromCents, toCents } from "../../utils/money";
import { IRecordPayment } from "./invoice.interface";
import {
  lockInvoice,
  logInvoiceEvent,
  readInvoice,
  recomputePaymentStatus,
} from "./invoice.shared";

// Money coming in (FR-INV-08, FR-INV-09, FR-INV-10): through the Mollie payment link, whose
// result Mollie reports by webhook, or recorded by hand for bank transfers. Both end up as
// rows in invoice_payments; the invoice's status is always worked out from those rows.

const isPublicUrl = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return (
      !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host) &&
      !host.endsWith(".local")
    );
  } catch {
    return false;
  }
};

// Mollie refuses a webhook address it cannot reach, so none is sent from a local machine.
// The "sync payment" call then updates an invoice on demand.
const webhookUrl = () =>
  config.base_url && isPublicUrl(config.base_url)
    ? `${config.base_url}/webhooks/mollie`
    : undefined;

// Modules built on top of the invoices (subscriptions) plug in here, so this file does not
// have to import them: a first direct-debit payment, and a direct debit that failed or was reversed
export interface IPaymentExtensions {
  onMandatePayment?: (paymentId: string) => Promise<boolean>;
  onDirectDebitFailure?: (event: {
    invoiceId: string;
    linkId: string;
    reason: string | null;
    reversed: boolean;
  }) => Promise<void>;
}
const extensions: IPaymentExtensions = {};
export const registerPaymentExtensions = (e: IPaymentExtensions) =>
  Object.assign(extensions, e);

const portalUrl = (invoiceId: string) =>
  `${config.frontend_url}/portal/invoices/${invoiceId}`;

const loadPayable = async (invoiceId: string) => {
  assertUuid(invoiceId, "invoice id");
  const found = await query(
    `
      SELECT id, number, kind, status, payment_status, relation_id,
             total_incl_vat::float8 AS total, paid_amount::float8 AS paid, credited_amount::float8 AS credited
      FROM invoices WHERE id = $1::uuid
    `,
    [invoiceId],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Invoice not found!");
  }
  const inv = found.rows[0];
  if (inv.status !== "ISSUED" || inv.kind === "CREDIT_NOTE") {
    throw new ApiError(
      httpStatus.CONFLICT,
      "Only an issued invoice can be paid!",
    );
  }
  const outstandingCents = Math.max(
    0,
    toCents(inv.total) - toCents(inv.credited) - toCents(inv.paid),
  );
  return { inv, outstandingCents };
};

// A new Mollie payment for what is still open. Each call makes a fresh link (a reminder
// gets its own); older open ones stay valid until the invoice is paid.
const createPaymentLink = async (invoiceId: string, actorId: string | null) => {
  const { inv, outstandingCents } = await loadPayable(invoiceId);
  if (outstandingCents <= 0) {
    throw new ApiError(
      httpStatus.CONFLICT,
      "There is nothing left to pay on this invoice!",
    );
  }

  const payment = await MollieService.createPayment({
    amountCents: outstandingCents,
    description: `Invoice ${inv.number}`,
    redirectUrl: portalUrl(inv.id),
    webhookUrl: webhookUrl(),
    metadata: { invoice_id: inv.id, invoice_number: inv.number },
  });

  const saved = await query(
    `
      INSERT INTO invoice_payment_links (invoice_id, mollie_payment_id, checkout_url, amount, status, created_by)
      VALUES ($1::uuid, $2, $3, $4, 'open', $5::uuid)
      RETURNING id, mollie_payment_id, checkout_url, amount::float8 AS amount, status, created_at AS "createdAt"
    `,
    [
      inv.id,
      payment.id,
      payment.checkoutUrl,
      fromCents(outstandingCents),
      actorId,
    ],
  );
  return { ...saved.rows[0], url: payment.checkoutUrl as string };
};

// ---------------------------------------------------------------------------
// By hand (FR-INV-10)
// ---------------------------------------------------------------------------

const recordPayment = async (
  invoiceId: string,
  input: IRecordPayment,
  actorId: string,
) => {
  const paidAt = input.paid_at
    ? input.paid_at.length === 10
      ? new Date(`${input.paid_at}T12:00:00Z`)
      : new Date(input.paid_at)
    : new Date();
  if (paidAt.getTime() > Date.now() + 86_400_000) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "A payment cannot be in the future!",
    );
  }

  await transaction(async (client) => {
    const invoice = await lockInvoice(client, invoiceId);
    if (invoice.status !== "ISSUED" || invoice.kind === "CREDIT_NOTE") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "A payment can only be recorded on an issued invoice!",
      );
    }
    const outstandingCents = Math.max(
      0,
      toCents(invoice.total_incl_vat) -
        toCents(invoice.credited_amount) -
        toCents(invoice.paid_amount),
    );
    if (outstandingCents <= 0) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "There is nothing left to pay on this invoice!",
      );
    }
    if (toCents(input.amount) > outstandingCents) {
      throw new ApiError(
        httpStatus.CONFLICT,
        `The amount is more than what is still open (${formatMoney(fromCents(outstandingCents), "EN")})!`,
      );
    }

    const inserted = await client.query(
      `
        INSERT INTO invoice_payments (invoice_id, amount, method, paid_at, reference, recorded_by)
        VALUES ($1::uuid, $2, $3, $4::timestamptz, $5, $6::uuid)
        RETURNING id
      `,
      [
        invoiceId,
        input.amount,
        input.method ?? "BANK",
        paidAt.toISOString(),
        input.reference?.trim() || null,
        actorId,
      ],
    );
    const result = await recomputePaymentStatus(client, invoiceId);

    await logInvoiceEvent(
      client,
      { id: invoiceId, relation_id: invoice.relation_id },
      "INVOICE_PAYMENT_RECEIVED",
      `Payment of ${formatMoney(input.amount, "EN")} recorded on invoice ${invoice.number}`,
      actorId,
      {
        description: input.reference ?? null,
        metadata: { method: input.method ?? "BANK", status: result?.status },
      },
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "CREATE",
        entity_type: "invoice_payment",
        entity_id: inserted.rows[0].id,
        changes: { invoice_id: invoiceId, amount: input.amount },
      },
      client,
    );
  });

  await cancelOpenLinksIfSettled(invoiceId);
  return readInvoice(invoiceId);
};

// A wrongly entered payment can be removed; payments from Mollie never can
const deletePayment = async (
  invoiceId: string,
  paymentId: string,
  actorId: string,
) => {
  assertUuid(paymentId, "payment id");

  await transaction(async (client) => {
    const invoice = await lockInvoice(client, invoiceId);
    const found = await client.query(
      `SELECT id, amount::float8 AS amount, method FROM invoice_payments WHERE id = $1::uuid AND invoice_id = $2::uuid FOR UPDATE`,
      [paymentId, invoiceId],
    );
    if (found.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Payment not found!");
    }
    if (found.rows[0].method === "MOLLIE") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "A payment made through Mollie cannot be removed!",
      );
    }

    await client.query(`DELETE FROM invoice_payments WHERE id = $1::uuid`, [
      paymentId,
    ]);
    await recomputePaymentStatus(client, invoiceId);
    await logInvoiceEvent(
      client,
      { id: invoiceId, relation_id: invoice.relation_id },
      "INVOICE_PAYMENT_REMOVED",
      `Payment of ${formatMoney(found.rows[0].amount, "EN")} removed from invoice ${invoice.number}`,
      actorId,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "DELETE",
        entity_type: "invoice_payment",
        entity_id: paymentId,
        changes: { invoice_id: invoiceId, amount: found.rows[0].amount },
      },
      client,
    );
  });

  return readInvoice(invoiceId);
};

// ---------------------------------------------------------------------------
// Through Mollie (FR-INV-09)
// ---------------------------------------------------------------------------

const linkStatus = (mollieStatus: string) =>
  (
    ({
      paid: "paid",
      expired: "expired",
      failed: "failed",
      canceled: "canceled",
      pending: "pending",
      authorized: "pending",
    }) as Record<string, string>
  )[mollieStatus] ?? "open";

// Applies what Mollie says about one of our payment links. Safe to repeat: a payment is
// recorded once, however many times Mollie calls the webhook. A direct debit that fails, or
// that the bank takes back later (a reversal), is reported to the subscriptions module.
const applyMolliePayment = async (
  link: { id: string; invoice_id: string },
  payment: IMolliePayment,
) => {
  const outcome = await transaction(async (client) => {
    const invoice = await lockInvoice(client, link.invoice_id);

    const current = await client.query(
      `SELECT status, kind FROM invoice_payment_links WHERE id = $1::uuid FOR UPDATE`,
      [link.id],
    );
    const previousStatus = current.rows[0]?.status as string | undefined;
    const isDirectDebit = current.rows[0]?.kind === "DIRECT_DEBIT";
    const newStatus = linkStatus(payment.status);

    await client.query(
      `UPDATE invoice_payment_links
       SET status = $2::varchar, failure_reason = CASE WHEN $2::varchar IN ('failed', 'expired', 'canceled') THEN COALESCE($3::text, failure_reason) ELSE failure_reason END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid`,
      [link.id, newStatus, payment.failureReason],
    );

    const result = {
      applied: false,
      failed: false,
      reversed: false,
      reason: payment.failureReason,
    };
    if (
      isDirectDebit &&
      ["failed", "expired", "canceled"].includes(newStatus) &&
      previousStatus !== newStatus
    ) {
      result.failed = true;
      return result;
    }
    if (payment.status !== "paid" || payment.amountCents <= 0) return result;

    const inserted = await client.query(
      `
        INSERT INTO invoice_payments (invoice_id, amount, method, mollie_payment_id, paid_at, reference)
        VALUES ($1::uuid, $2, 'MOLLIE', $3, $4::timestamptz, $5)
        ON CONFLICT (mollie_payment_id) DO NOTHING
        RETURNING id
      `,
      [
        link.invoice_id,
        fromCents(payment.amountCents),
        payment.id,
        payment.paidAt ?? new Date().toISOString(),
        payment.id,
      ],
    );
    if (inserted.rows.length > 0) {
      const status = await recomputePaymentStatus(client, link.invoice_id);
      await logInvoiceEvent(
        client,
        { id: link.invoice_id, relation_id: invoice.relation_id },
        "INVOICE_PAYMENT_RECEIVED",
        `Payment of ${formatMoney(fromCents(payment.amountCents), "EN")} received through Mollie on invoice ${invoice.number}`,
        null,
        {
          metadata: {
            method: "MOLLIE",
            mollie_payment_id: payment.id,
            status: status?.status,
          },
        },
      );
      await logAudit(
        {
          actor_id: null,
          action: "CREATE",
          entity_type: "invoice_payment",
          entity_id: inserted.rows[0].id,
          changes: {
            invoice_id: link.invoice_id,
            amount: fromCents(payment.amountCents),
            mollie: payment.id,
          },
        },
        client,
      );
      result.applied = true;
    }

    // The bank took the money back (a reversed direct debit): the payment no longer counts
    if (payment.chargedBackCents > 0) {
      const reversed = await client.query(
        `UPDATE invoice_payments SET reversed_at = CURRENT_TIMESTAMP, reversal_reason = $2
         WHERE mollie_payment_id = $1 AND reversed_at IS NULL RETURNING id`,
        [payment.id, payment.failureReason ?? "Reversed by the bank"],
      );
      if (reversed.rows.length > 0) {
        const status = await recomputePaymentStatus(client, link.invoice_id);
        await logInvoiceEvent(
          client,
          { id: link.invoice_id, relation_id: invoice.relation_id },
          "INVOICE_PAYMENT_REVERSED",
          `Payment on invoice ${invoice.number} was reversed by the bank`,
          null,
          {
            metadata: { mollie_payment_id: payment.id, status: status?.status },
          },
        );
        await logAudit(
          {
            actor_id: null,
            action: "UPDATE",
            entity_type: "invoice_payment",
            entity_id: reversed.rows[0].id,
            changes: { reversed: true, mollie: payment.id },
          },
          client,
        );
        result.reversed = true;
        result.applied = false;
      }
    }
    return result;
  });

  if (outcome.failed || outcome.reversed) {
    try {
      await extensions.onDirectDebitFailure?.({
        invoiceId: link.invoice_id,
        linkId: link.id,
        reason: outcome.reason,
        reversed: outcome.reversed,
      });
    } catch (error: any) {
      console.error(
        "❌ Direct debit follow-up failed:",
        error?.message ?? error,
      );
    }
  }
  if (outcome.applied) await cancelOpenLinksIfSettled(link.invoice_id);
  return outcome.applied;
};

// Mollie calls this (POST /webhooks/mollie) with just a payment id. Only payments we made
// ourselves are looked at, and the truth is read from Mollie, never from the request.
const handleMollieWebhook = async (paymentId: string) => {
  if (!/^tr_[A-Za-z0-9]{4,40}$/.test(paymentId)) return { ignored: true };

  const found = await query(
    `SELECT id, invoice_id FROM invoice_payment_links WHERE mollie_payment_id = $1`,
    [paymentId],
  );
  if (found.rows.length === 0) {
    // Not an invoice payment: it may be the first payment that sets up a direct debit mandate
    const handled = extensions.onMandatePayment
      ? await extensions.onMandatePayment(paymentId)
      : false;
    return { ignored: !handled };
  }

  const payment = await MollieService.getPayment(paymentId);
  const applied = await applyMolliePayment(found.rows[0], payment);
  return { ignored: false, status: payment.status, applied };
};

// For when the webhook cannot reach us (a local machine) or was missed: ask Mollie now
const syncPayments = async (invoiceId: string) => {
  assertUuid(invoiceId, "invoice id");
  const exists = await query(`SELECT 1 FROM invoices WHERE id = $1::uuid`, [
    invoiceId,
  ]);
  if (exists.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Invoice not found!");
  }

  const links = await query(
    `SELECT id, invoice_id, mollie_payment_id FROM invoice_payment_links WHERE invoice_id = $1::uuid AND status IN ('open', 'pending') ORDER BY created_at ASC`,
    [invoiceId],
  );
  for (const link of links.rows) {
    const payment = await MollieService.getPayment(link.mollie_payment_id);
    await applyMolliePayment(link, payment);
  }
  return readInvoice(invoiceId);
};

// Once an invoice is paid or credited its other open links should stop working
const cancelOpenLinksIfSettled = async (invoiceId: string) => {
  const settled = await query(
    `SELECT payment_status FROM invoices WHERE id = $1::uuid`,
    [invoiceId],
  );
  if (!["PAID", "CREDITED"].includes(settled.rows[0]?.payment_status)) return;

  const open = await query(
    `SELECT id, mollie_payment_id FROM invoice_payment_links WHERE invoice_id = $1::uuid AND status = 'open'`,
    [invoiceId],
  );
  if (open.rows.length === 0) return;
  if (!(await MollieService.getConfig())) return;

  for (const link of open.rows) {
    await MollieService.cancelPayment(link.mollie_payment_id);
    await query(
      `UPDATE invoice_payment_links SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [link.id],
    );
  }
};

export const InvoicePaymentService = {
  createPaymentLink,
  recordPayment,
  deletePayment,
  handleMollieWebhook,
  syncPayments,
  cancelOpenLinksIfSettled,
  portalUrl,
  webhookUrl,
};
