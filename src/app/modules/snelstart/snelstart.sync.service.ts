import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { query, transaction } from "../../utils/db";
import { toCents } from "../../utils/money";
import { createAutomaticAction } from "../actions/actions.shared";
import { InvoicePaymentService } from "../invoice/invoice.payment.service";
import { lockInvoice, logInvoiceEvent, recomputePaymentStatus } from "../invoice/invoice.shared";
import { notify } from "../messages/notification.shared";
import { calculateTotals } from "../quote/quote.calculation";
import { SettingsService } from "../settings/settings.service";
import { odataString, snelstartCall, snelstartList, SnelStartError } from "./snelstart.client";
import {
  BALANCE_BATCH, BALANCE_RECHECK_MINUTES, BATCH_SIZE, entityTypes, MAX_ATTEMPTS, STALE_SENDING_MINUTES, TEntityType,
} from "./snelstart.interface";
import {
  buildDocument, buildPurchaseBooking, buildRelatie, buildSalesBooking, IBookingLine, IBookingVat, normalizeVatNumber,
} from "./snelstart.payloads";
import { markConnection, resolveLedger, vatMappingFor } from "./snelstart.settings.service";

// The synchronisation (FR-SNEL-03 .. FR-SNEL-09): a queue of issued sales invoices / credit notes and approved purchase
// invoices, sent to SnelStart as bookings with the PDF attached, after making sure the customer or supplier exists there.
// A record is sent once and never edited or deleted afterwards. A run is safe to repeat, crash or run on two servers.

const settingsRow = async () => (await query(`SELECT * FROM snelstart_settings WHERE id = TRUE`)).rows[0];

const adminIds = async (): Promise<string[]> =>
  (await query(`SELECT id FROM users WHERE is_active AND status = 'ACTIVE' AND role::text IN ('ADMIN', 'SUPERADMIN')`)).rows.map((r: any) => r.id);

// Every sync action is logged, with what SnelStart answered (FR-SNEL-08). Never throws.
const log = async (
  item: { id?: string | null; entity_type?: string | null; entity_id?: string | null } | null,
  action: string,
  status: "OK" | "FAILED" | "INFO",
  message: string,
  details: Record<string, any> = {},
) => {
  try {
    await query(
      `INSERT INTO snelstart_sync_log (item_id, entity_type, entity_id, action, status, message, details) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb)`,
      [item?.id ?? null, item?.entity_type ?? null, item?.entity_id ?? null, action, status, message.slice(0, 2000), JSON.stringify(details)],
    );
  } catch (error: any) {
    console.error("❌ Could not write the SnelStart log:", error?.message ?? error);
  }
};

const closeTask = async (itemId: string, note: string) =>
  query(
    `UPDATE actions SET status = 'DONE', completed_at = CURRENT_TIMESTAMP, completion_note = $2, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'OPEN' AND auto_type = 'snelstart_sync_error' AND auto_key = $1`,
    [`snelstart_sync_error:${itemId}`, `Closed automatically: ${note}`],
  ).catch(() => undefined);

// ---------------------------------------------------------------------------
// The customer or supplier in SnelStart (FR-SNEL-03)
// ---------------------------------------------------------------------------

let landenCache: { at: number; list: any[] } | null = null;
const landIdFor = async (iso: string | null | undefined) => {
  if (!iso) return null;
  if (!landenCache || Date.now() - landenCache.at > 3_600_000) landenCache = { at: Date.now(), list: await snelstartList("landen", undefined, { maxPages: 5 }).catch(() => []) };
  return landenCache.list.find((l: any) => String(l.landcodeISO ?? "").toUpperCase() === iso.toUpperCase())?.id ?? null;
};

const sameDigits = (a?: string | null, b?: string | null) => !!a && !!b && String(a).replace(/\D/g, "") === String(b).replace(/\D/g, "");

// An existing SnelStart relation is matched by KvK number, VAT number or email before a new one is made
const findExisting = async (relation: any): Promise<{ relatie: any; matchedOn: string } | null> => {
  const email = (relation.invoice_email ?? relation.email)?.toLowerCase() ?? null;
  const vat = normalizeVatNumber(relation.vat_number);
  const attempts: { field: string; filter: string | null; test: (r: any) => boolean }[] = [
    { field: "kvk", filter: relation.kvk_number ? `kvkNummer eq ${odataString(relation.kvk_number)}` : null, test: (r) => sameDigits(r.kvkNummer, relation.kvk_number) },
    { field: "vat", filter: vat ? `btwNummer eq ${odataString(vat)}` : null, test: (r) => normalizeVatNumber(r.btwNummer) === vat },
    { field: "email", filter: email ? `email eq ${odataString(email)}` : null, test: (r) => String(r.email ?? "").toLowerCase() === email },
  ];
  const active = (list: any[]) => list.filter((r) => !r.nonactief);

  let filterWorks = true;
  for (const a of attempts) {
    if (!a.filter) continue;
    try {
      const hits = active(await snelstartList("relaties", a.filter, { maxPages: 1 })).filter(a.test);
      if (hits.length > 0) return { relatie: hits[0], matchedOn: a.field };
    } catch (error: any) {
      // The server did not accept the filter: look through the list ourselves instead
      if (error instanceof SnelStartError && error.kind === "VALIDATION") {
        filterWorks = false;
        break;
      }
      throw error;
    }
  }
  if (!filterWorks) {
    const all = active(await snelstartList("relaties", undefined, { maxPages: 20 }));
    for (const a of attempts) {
      if (!a.filter) continue;
      const hit = all.find(a.test);
      if (hit) return { relatie: hit, matchedOn: a.field };
    }
  }
  return null;
};

// Returns the SnelStart id of the relation, creating it or matching an existing one the first time. The id is kept in
// the CRM so the next booking never searches again.
const ensureRelation = async (item: any, relationId: string, role: "Klant" | "Leverancier"): Promise<string> => {
  const found = await query(
    `SELECT id, name, email, invoice_email, phone, kvk_number, vat_number, iban, payment_term_days, snelstart_relation_id,
            billing_street, billing_house_number, billing_postcode, billing_city, billing_country
     FROM relations WHERE id = $1::uuid`,
    [relationId],
  );
  const relation = found.rows[0];
  if (!relation) throw new SnelStartError("VALIDATION", "The customer or supplier of this record no longer exists.");
  if (relation.snelstart_relation_id) return relation.snelstart_relation_id;

  const existing = await findExisting(relation);
  let snelstartId: string;
  if (existing) {
    snelstartId = String(existing.relatie.id);
    // matched, but not yet known there as a customer / supplier: add that, keep everything else as it is
    const soorten: string[] = existing.relatie.relatiesoort ?? [];
    if (!soorten.includes(role)) {
      await snelstartCall("PUT", `relaties/${snelstartId}`, { body: { ...existing.relatie, relatiesoort: [...soorten, role] } });
    }
    await log(item, "RELATION_MATCHED", "OK", `${relation.name} matched with an existing SnelStart relation (${existing.matchedOn})`, { snelstart_id: snelstartId, matched_on: existing.matchedOn });
  } else {
    const land = await landIdFor(relation.billing_country ?? "NL");
    const created = await snelstartCall("POST", "relaties", { body: buildRelatie(relation, role, land) });
    if (!created?.id) throw new SnelStartError("VALIDATION", "SnelStart did not return an id for the new relation.");
    snelstartId = String(created.id);
    await log(item, "RELATION_CREATED", "OK", `${relation.name} created in SnelStart as ${role}`, { snelstart_id: snelstartId });
  }
  await query(`UPDATE relations SET snelstart_relation_id = $2 WHERE id = $1::uuid`, [relationId, snelstartId]);
  return snelstartId;
};

// ---------------------------------------------------------------------------
// Building the bookings
// ---------------------------------------------------------------------------

const asCents = (n: any) => toCents(Number(n));

// Sums VAT amounts per label ("VerkopenHoog") and leaves out labels that mean "no VAT"
const vatEntries = (groups: { soort: string; cents: number }[]): IBookingVat[] => {
  const sums = new Map<string, number>();
  for (const g of groups) if (g.soort !== "Geen") sums.set(g.soort, (sums.get(g.soort) ?? 0) + g.cents);
  return [...sums.entries()].map(([btwSoort, amountCents]) => ({ btwSoort, amountCents }));
};

const loadSalesInvoice = async (id: string) => {
  const found = await query(
    `
      SELECT i.id, i.number, i.kind, i.status, i.relation_id, i.title, i.payment_term_days, i.pdf_data,
             to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
             i.total_incl_vat::float8 AS total_incl_vat, o.number AS original_number, st.key AS service_type_key
      FROM invoices i
      LEFT JOIN invoices o ON o.id = i.credit_for_id
      LEFT JOIN projects p ON p.id = i.project_id
      LEFT JOIN service_types st ON st.id = p.service_type_id
      WHERE i.id = $1::uuid
    `,
    [id],
  );
  const inv = found.rows[0];
  if (!inv) throw new SnelStartError("VALIDATION", "The invoice no longer exists.");
  if (inv.status !== "ISSUED" || !inv.number) throw new SnelStartError("VALIDATION", "Only an issued invoice can be sent to SnelStart.");
  if (!inv.pdf_data) throw new SnelStartError("VALIDATION", "The invoice has no PDF to attach.");
  const lines = await query(
    `SELECT quantity::float8 AS quantity, unit_price::float8 AS unit_price, vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge
     FROM invoice_lines WHERE invoice_id = $1::uuid ORDER BY sort_order`,
    [id],
  );
  return { inv, lines: lines.rows };
};

const buildSalesPayload = async (inv: any, lines: any[], customerId: string) => {
  const totals = calculateTotals(lines.map((l) => ({ ...l, cost_price: 0 })));
  const sumCents = totals.vat.reduce((n, g) => n + g.baseCents + g.vatCents, 0);
  if (sumCents !== asCents(inv.total_incl_vat)) {
    throw new SnelStartError("VALIDATION", `The invoice lines (${sumCents / 100}) do not add up to the invoice total (${inv.total_incl_vat}).`);
  }
  const label = inv.kind === "CREDIT_NOTE" ? `Credit note ${inv.number}${inv.original_number ? ` for ${inv.original_number}` : ""}` : `Invoice ${inv.number}`;
  const bookingLines: IBookingLine[] = [];
  const vatGroups: { soort: string; cents: number }[] = [];
  for (const g of totals.vat) {
    const [ledger, vm] = await Promise.all([resolveLedger("REVENUE", g.code, inv.service_type_key ?? null), vatMappingFor(g.code)]);
    bookingLines.push({ description: `${inv.title ?? label}${totals.vat.length > 1 ? ` (${g.reverse_charge ? "VAT reverse charged" : `VAT ${g.rate}%`})` : ""}`, grootboekId: ledger.grootboek_id, amountCents: g.baseCents, vat: vm });
    vatGroups.push({ soort: vm.sales_btw_regel_soort, cents: g.vatCents });
  }
  return buildSalesBooking({
    number: inv.number,
    customerId,
    invoiceDate: inv.invoice_date,
    dueDate: inv.due_date,
    paymentTermDays: inv.payment_term_days ?? 14,
    description: inv.title ? `${label}: ${inv.title}` : label,
    totalCents: asCents(inv.total_incl_vat),
    lines: bookingLines,
    vat: vatEntries(vatGroups),
  });
};

// A supplier invoice does not always carry a VAT code: work it out from its amounts when there is no doubt
const inferVatCode = async (excl: number, vat: number): Promise<string> => {
  const rates = (await SettingsService.getCompanySettings()).vat_rates as { code: string; rate: number; reverse_charge: boolean }[];
  if (vat === 0) {
    const zero = rates.find((r) => r.rate === 0 && !r.reverse_charge);
    if (zero) return zero.code;
  } else if (excl !== 0) {
    const pct = (vat / excl) * 100;
    const hit = rates.find((r) => !r.reverse_charge && Math.abs(r.rate - pct) < 0.2);
    if (hit) return hit.code;
  }
  throw new SnelStartError("VALIDATION", "The supplier invoice has no VAT code and it cannot be worked out from the amounts. Set the VAT code on the invoice, then retry.");
};

const loadPurchaseInvoice = async (id: string) => {
  const found = await query(
    `
      SELECT si.id, si.supplier_id, si.invoice_number, si.status, si.description, si.file_data, si.file_name, si.file_mime,
             to_char(si.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(si.due_date, 'YYYY-MM-DD') AS due_date,
             si.amount_excl_vat::float8 AS excl, si.vat_amount::float8 AS vat, si.amount_incl_vat::float8 AS incl, si.vat_code,
             r.name AS supplier_name
      FROM supplier_invoices si JOIN relations r ON r.id = si.supplier_id WHERE si.id = $1::uuid
    `,
    [id],
  );
  return found.rows[0] ?? null;
};

const buildPurchasePayload = async (si: any, supplierId: string) => {
  const vatCode = si.vat_code ?? (await inferVatCode(si.excl, si.vat));
  const [ledger, vm] = await Promise.all([resolveLedger("COST", vatCode, null), vatMappingFor(vatCode)]);
  const exclCents = asCents(si.excl);
  const vatCents = asCents(si.vat);
  return buildPurchaseBooking({
    number: si.invoice_number,
    supplierId,
    invoiceDate: si.invoice_date,
    dueDate: si.due_date ?? si.invoice_date,
    description: si.description ? `${si.supplier_name}: ${si.description}` : `${si.supplier_name} ${si.invoice_number}`,
    totalCents: asCents(si.incl),
    lines: [{ description: si.description ?? `${si.supplier_name} ${si.invoice_number}`, grootboekId: ledger.grootboek_id, amountCents: exclCents, vat: vm }],
    vat: vatEntries([{ soort: vm.purchase_btw_regel_soort, cents: vatCents }]),
  });
};

// ---------------------------------------------------------------------------
// Sending one record
// ---------------------------------------------------------------------------

// Is the booking there already? (a run that died after SnelStart accepted it but before the CRM wrote it down)
const findBookingByNumber = async (resource: "verkoopfacturen" | "inkoopfacturen", number: string): Promise<string | null> => {
  const hits = await snelstartList(resource, `factuurnummer eq ${odataString(number)}`, { maxPages: 1 });
  const hit = hits.find((h: any) => String(h.factuurnummer) === number);
  return hit ? String(hit.verkoopBoeking?.id ?? hit.inkoopBoeking?.id ?? hit.boeking?.id ?? hit.id) : null;
};

const setStep = (id: string, fields: Record<string, any>) => {
  const keys = Object.keys(fields);
  return query(
    `UPDATE snelstart_sync_items SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
    [id, ...keys.map((k) => fields[k])],
  );
};

const sendSales = async (item: any) => {
  const { inv, lines } = await loadSalesInvoice(item.entity_id);
  let bookingId: string | null = item.snelstart_id;

  if (item.step === "BOOKING") {
    const customerId = item.relation_snelstart_id ?? (await ensureRelation(item, inv.relation_id, "Klant"));
    if (!item.relation_snelstart_id) await setStep(item.id, { relation_snelstart_id: customerId });
    if (!bookingId && item.attempts > 0) bookingId = await findBookingByNumber("verkoopfacturen", inv.number);
    if (!bookingId) {
      const created = await snelstartCall("POST", "verkoopboekingen", { body: await buildSalesPayload(inv, lines, customerId) });
      if (!created?.id) throw new SnelStartError("VALIDATION", "SnelStart did not return an id for the booking.");
      bookingId = String(created.id);
      await log(item, "BOOKING_SENT", "OK", `${inv.kind === "CREDIT_NOTE" ? "Credit note" : "Invoice"} ${inv.number} sent as a sales booking`, { snelstart_id: bookingId });
    }
    await setStep(item.id, { snelstart_id: bookingId, step: "DOCUMENT" });
    item.step = "DOCUMENT";
  }

  if (item.step === "DOCUMENT") {
    await snelstartCall("POST", "documenten/Verkoopboekingen", { body: buildDocument(bookingId as string, `${inv.number}.pdf`, inv.pdf_data) });
    await log(item, "DOCUMENT_ATTACHED", "OK", `PDF of ${inv.number} attached`, { snelstart_id: bookingId });
    await setStep(item.id, { step: "DONE" });
  }
};

const extFor = (mime?: string | null) => ({ "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Record<string, string>)[mime ?? ""] ?? "pdf";

// Returns false when there is nothing to send any more (the invoice was unapproved or voided meanwhile)
const sendPurchase = async (item: any): Promise<boolean> => {
  const si = await loadPurchaseInvoice(item.entity_id);
  if (!si || !["APPROVED", "PAID"].includes(si.status)) return false;
  if (!si.file_data) throw new SnelStartError("VALIDATION", "The supplier invoice has no document to attach.");
  let bookingId: string | null = item.snelstart_id;

  if (item.step === "BOOKING") {
    const supplierId = item.relation_snelstart_id ?? (await ensureRelation(item, si.supplier_id, "Leverancier"));
    if (!item.relation_snelstart_id) await setStep(item.id, { relation_snelstart_id: supplierId });
    if (!bookingId && item.attempts > 0) bookingId = await findBookingByNumber("inkoopfacturen", si.invoice_number);
    if (!bookingId) {
      const created = await snelstartCall("POST", "inkoopboekingen", { body: await buildPurchasePayload(si, supplierId) });
      if (!created?.id) throw new SnelStartError("VALIDATION", "SnelStart did not return an id for the booking.");
      bookingId = String(created.id);
      await log(item, "BOOKING_SENT", "OK", `Supplier invoice ${si.invoice_number} sent as a purchase booking`, { snelstart_id: bookingId });
    }
    await setStep(item.id, { snelstart_id: bookingId, step: "DOCUMENT" });
    item.step = "DOCUMENT";
  }

  if (item.step === "DOCUMENT") {
    const name = si.file_name ?? `${si.invoice_number}.${extFor(si.file_mime)}`;
    await snelstartCall("POST", "documenten/Inkoopboekingen", { body: buildDocument(bookingId as string, name, si.file_data) });
    await log(item, "DOCUMENT_ATTACHED", "OK", `Document of ${si.invoice_number} attached`, { snelstart_id: bookingId });
    await setStep(item.id, { step: "DONE" });
  }
  return true;
};

// What to do after a failure, by what kind of failure it is
const failureBackoffMinutes = (attempts: number) => Math.min(2 ** attempts, 60);

type TOutcome = "SENT" | "FAILED" | "RETRY" | "PAUSE_AUTH" | "PAUSE_RATE" | "CANCELLED" | "SKIPPED";

const afterFailure = async (item: any, error: unknown): Promise<TOutcome> => {
  const e = error instanceof SnelStartError ? error : new SnelStartError("VALIDATION", (error as any)?.message ?? "Unexpected error");
  if (!(error instanceof SnelStartError)) console.error("❌ SnelStart sync item failed unexpectedly:", error);

  if (e.kind === "AUTH" || e.kind === "NOT_CONFIGURED") {
    // Nothing is wrong with the record: the connection must be fixed. It waits.
    await setStep(item.id, { status: "PENDING", last_error: e.message, last_error_code: e.kind, next_attempt_at: new Date(Date.now() + 5 * 60_000) });
    await log(item, "CONNECTION", "FAILED", e.message, { kind: e.kind });
    await markConnection("ERROR", e.message);
    return "PAUSE_AUTH";
  }
  if (e.kind === "RATE_LIMIT") {
    const wait = (e.retryAfterSeconds ?? 60) * 1000;
    await setStep(item.id, { status: "PENDING", last_error: e.message, last_error_code: e.kind, next_attempt_at: new Date(Date.now() + wait) });
    await query(`UPDATE snelstart_settings SET retry_after = $1 WHERE id = TRUE`, [new Date(Date.now() + wait)]);
    await log(item, "RATE_LIMIT", "INFO", e.message);
    return "PAUSE_RATE";
  }

  const attempts = item.attempts + 1;
  if (e.kind === "TEMPORARY" && attempts < MAX_ATTEMPTS) {
    await setStep(item.id, { status: "PENDING", attempts, last_error: e.message, last_error_code: e.kind, next_attempt_at: new Date(Date.now() + failureBackoffMinutes(attempts) * 60_000) });
    await log(item, "RETRY", "FAILED", `${e.message} (attempt ${attempts} of ${MAX_ATTEMPTS}, trying again later)`, { kind: e.kind });
    return "RETRY";
  }

  // The record needs a person: list it, make a task for the Beheerder, and tell them (FR-SNEL-08)
  await setStep(item.id, { status: "FAILED", attempts, last_error: e.message, last_error_code: e.kind });
  await log(item, "FAILED", "FAILED", e.message, { kind: e.kind, step: item.step, details: e.details ?? null });
  const label = item.entity_type === "SALES_INVOICE" ? "invoice" : "supplier invoice";
  const record = await recordLabel(item);
  const made = await createAutomaticAction({
    auto_type: "snelstart_sync_error",
    auto_key: `snelstart_sync_error:${item.id}`,
    title: `SnelStart: ${label} ${record ?? ""} could not be sent`.replace(/\s+/g, " "),
    description: `${e.message} Correct it, then retry it in Settings > SnelStart > queue.`,
    entity: { type: item.entity_type === "SALES_INVOICE" ? "invoice" : "supplier_invoice", id: item.entity_id },
  });
  if (made.created) {
    await notify(await adminIds(), { type: "SNELSTART_SYNC", title: `SnelStart: ${label} ${record ?? ""} could not be sent`.replace(/\s+/g, " "), body: e.message, entity: { type: item.entity_type === "SALES_INVOICE" ? "invoice" : "supplier_invoice", id: item.entity_id } });
  }
  return "FAILED";
};

const recordLabel = async (item: any): Promise<string | null> => {
  const r =
    item.entity_type === "SALES_INVOICE"
      ? await query(`SELECT number AS label FROM invoices WHERE id = $1::uuid`, [item.entity_id])
      : await query(`SELECT invoice_number AS label FROM supplier_invoices WHERE id = $1::uuid`, [item.entity_id]);
  return r.rows[0]?.label ?? null;
};

// Works on one queued record. Returns what became of it, or null when someone else already has it.
export const processItem = async (itemId: string): Promise<TOutcome | null> => {
  const claimed = await query(
    `UPDATE snelstart_sync_items SET status = 'SENDING', updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid AND status = 'PENDING' RETURNING *`,
    [itemId],
  );
  const item = claimed.rows[0];
  if (!item) return null;

  try {
    if (item.entity_type === "SALES_INVOICE") {
      await sendSales(item);
    } else if (!(await sendPurchase(item))) {
      await setStep(item.id, { status: "CANCELLED" });
      await log(item, "WITHDRAWN", "INFO", "The invoice is no longer approved, so nothing was sent.");
      return "CANCELLED";
    }
    await setStep(item.id, { status: "SENT", step: "DONE", sent_at: new Date(), last_error: null, last_error_code: null });
    await closeTask(item.id, "the record was sent to SnelStart");
    return "SENT";
  } catch (error) {
    return afterFailure(item, error);
  }
};

// ---------------------------------------------------------------------------
// Reading back what was settled in SnelStart (FR-SNEL-07, FR-INV-10)
// ---------------------------------------------------------------------------

// An invoice that SnelStart shows as settled (nothing open any more, for example after a bank transfer was processed
// there) is marked paid in the CRM. Mollie stays the main source: an invoice paid through Mollie has nothing left.
const readBalances = async (): Promise<number> => {
  const due = await query(
    `
      SELECT it.id, it.entity_id, i.number
      FROM snelstart_sync_items it JOIN invoices i ON i.id = it.entity_id
      WHERE it.entity_type = 'SALES_INVOICE' AND it.status = 'SENT' AND it.step = 'DONE'
        AND i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID')
        AND (it.balance_checked_at IS NULL OR it.balance_checked_at < CURRENT_TIMESTAMP - make_interval(mins => $1::int))
      ORDER BY it.balance_checked_at NULLS FIRST, it.created_at
      LIMIT ${BALANCE_BATCH}
    `,
    [BALANCE_RECHECK_MINUTES],
  );
  let settled = 0;
  for (const row of due.rows) {
    const hits = await snelstartList("verkoopfacturen", `factuurnummer eq ${odataString(row.number)}`, { maxPages: 1 });
    const hit = hits.find((h: any) => String(h.factuurnummer) === row.number);
    await query(`UPDATE snelstart_sync_items SET balance_checked_at = CURRENT_TIMESTAMP, open_balance = $2 WHERE id = $1::uuid`, [row.id, hit && Number.isFinite(Number(hit.openstaandSaldo)) ? Number(hit.openstaandSaldo) : null]);
    if (!hit || !Number.isFinite(Number(hit.openstaandSaldo)) || Math.abs(Number(hit.openstaandSaldo)) >= 0.005) continue;
    if (await settleFromSnelStart(row.entity_id, row.number, row.id)) settled++;
  }
  return settled;
};

const settleFromSnelStart = async (invoiceId: string, number: string, itemId: string): Promise<boolean> => {
  const done = await transaction(async (client) => {
    const invoice = await lockInvoice(client, invoiceId);
    const outstandingCents = Math.max(0, asCents(invoice.total_incl_vat) - asCents(invoice.credited_amount) - asCents(invoice.paid_amount));
    if (invoice.status !== "ISSUED" || invoice.kind === "CREDIT_NOTE" || outstandingCents <= 0) return false;
    const inserted = await client.query(
      `INSERT INTO invoice_payments (invoice_id, amount, method, paid_at, reference) VALUES ($1::uuid, $2, 'BANK', CURRENT_TIMESTAMP, $3) RETURNING id`,
      [invoiceId, outstandingCents / 100, "Settled in SnelStart"],
    );
    const status = await recomputePaymentStatus(client, invoiceId);
    await logInvoiceEvent(client, { id: invoiceId, relation_id: invoice.relation_id }, "INVOICE_PAYMENT_RECEIVED", `Invoice ${number} is settled in SnelStart (payment of ${outstandingCents / 100} recorded)`, null, {
      metadata: { method: "BANK", source: "SNELSTART", status: status?.status },
    });
    await logAudit({ actor_id: null, action: "CREATE", entity_type: "invoice_payment", entity_id: inserted.rows[0].id, changes: { invoice_id: invoiceId, amount: outstandingCents / 100, source: "snelstart" } }, client);
    return true;
  });
  if (done) {
    await InvoicePaymentService.cancelOpenLinksIfSettled(invoiceId);
    await log({ id: itemId, entity_type: "SALES_INVOICE", entity_id: invoiceId }, "PAYMENT_READ", "OK", `Invoice ${number} is settled in SnelStart: marked as paid`);
  }
  return done;
};

// ---------------------------------------------------------------------------
// Running the synchronisation (FR-SNEL-06)
// ---------------------------------------------------------------------------

export interface ISyncResult {
  ran: boolean;
  reason?: string;
  sent: number;
  failed: number;
  retrying: number;
  cancelled: number;
  settled: number;
}
const emptyResult = (reason?: string): ISyncResult => ({ ran: false, reason, sent: 0, failed: 0, retrying: 0, cancelled: 0, settled: 0 });

// Only one run at a time, over every server: the lock is a time stamp in the settings row
const acquireLock = async () => {
  const r = await query(
    `UPDATE snelstart_settings SET sync_lock_until = CURRENT_TIMESTAMP + interval '10 minutes'
     WHERE id = TRUE AND (sync_lock_until IS NULL OR sync_lock_until < CURRENT_TIMESTAMP) RETURNING 1`,
  );
  return r.rows.length > 0;
};
const releaseLock = () => query(`UPDATE snelstart_settings SET sync_lock_until = NULL WHERE id = TRUE`).catch(() => undefined);

const runSync = async (options: { force?: boolean } = {}): Promise<ISyncResult> => {
  const settings = await settingsRow();
  if (!settings.is_enabled && !options.force) return emptyResult("DISABLED");
  if (!settings.connection_key_encrypted) return emptyResult("NOT_CONNECTED");
  if (settings.retry_after && new Date(settings.retry_after) > new Date() && !options.force) return emptyResult("RATE_LIMITED");
  if (!(await acquireLock())) return emptyResult("ALREADY_RUNNING");

  const result: ISyncResult = { ...emptyResult(), ran: true };
  try {
    // A run that died leaves records marked SENDING: put them back
    await query(
      `UPDATE snelstart_sync_items SET status = 'PENDING', updated_at = CURRENT_TIMESTAMP
       WHERE status = 'SENDING' AND updated_at < CURRENT_TIMESTAMP - make_interval(mins => $1::int)`,
      [STALE_SENDING_MINUTES],
    );

    const items = await query(
      `SELECT id FROM snelstart_sync_items WHERE status = 'PENDING' AND next_attempt_at <= CURRENT_TIMESTAMP ORDER BY created_at ASC, id ASC LIMIT ${BATCH_SIZE}`,
    );
    let paused = false;
    for (const row of items.rows) {
      const outcome = await processItem(row.id);
      if (outcome === "SENT") result.sent++;
      else if (outcome === "FAILED") result.failed++;
      else if (outcome === "RETRY") result.retrying++;
      else if (outcome === "CANCELLED") result.cancelled++;
      else if (outcome === "PAUSE_AUTH" || outcome === "PAUSE_RATE") {
        paused = true;
        break;
      }
    }

    if (!paused) {
      try {
        result.settled = await readBalances();
        // A working run means the connection works
        if (settings.connection_status !== "CONNECTED") await markConnection("CONNECTED", null);
      } catch (error: any) {
        if (error instanceof SnelStartError && error.kind === "AUTH") await markConnection("ERROR", error.message);
        else if (error instanceof SnelStartError && error.kind === "RATE_LIMIT") await query(`UPDATE snelstart_settings SET retry_after = $1 WHERE id = TRUE`, [new Date(Date.now() + (error.retryAfterSeconds ?? 60) * 1000)]);
        else await log(null, "PAYMENT_READ", "FAILED", error?.message ?? "Reading the open balances failed");
      }
    }
    await query(`UPDATE snelstart_settings SET last_sync_at = CURRENT_TIMESTAMP WHERE id = TRUE`);
  } finally {
    await releaseLock();
  }
  return result;
};

// The scheduled run: only when the interval has passed
const runIfDue = async (): Promise<ISyncResult> => {
  const s = await settingsRow();
  if (!s.is_enabled) return emptyResult("DISABLED");
  const last = s.last_sync_at ? new Date(s.last_sync_at).getTime() : 0;
  if (Date.now() - last < s.sync_interval_minutes * 60_000) return emptyResult("NOT_DUE");
  return runSync();
};

// ---------------------------------------------------------------------------
// The queue and the log, for the Beheerder and the office (permission matrix: Beheerder configure, Kantoor view and retry)
// ---------------------------------------------------------------------------

const itemColumns = `
  it.id, it.entity_type, it.entity_id, it.status, it.step, it.attempts, it.next_attempt_at, it.snelstart_id, it.last_error, it.last_error_code,
  it.open_balance::float8 AS open_balance, it.balance_checked_at, it.created_at AS "createdAt", it.sent_at,
  CASE it.entity_type WHEN 'SALES_INVOICE' THEN (SELECT json_build_object('number', i.number, 'kind', i.kind, 'total_incl_vat', i.total_incl_vat::float8, 'customer', i.customer_name) FROM invoices i WHERE i.id = it.entity_id)
                      ELSE (SELECT json_build_object('number', s.invoice_number, 'total_incl_vat', s.amount_incl_vat::float8, 'supplier', r.name) FROM supplier_invoices s JOIN relations r ON r.id = s.supplier_id WHERE s.id = it.entity_id) END AS record
`;

const paged = (rows: any[], total: number, page: number, limit: number) => {
  const totalPage = Math.ceil(total / limit);
  return { data: rows, meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 } };
};

const getQueue = async (params: Record<string, any>) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const where: string[] = [];
  const values: any[] = [];
  if (params.status) {
    const list = String(params.status).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    values.push(list);
    where.push(`it.status = ANY($${values.length}::text[])`);
  }
  if (params.entity_type) {
    const t = String(params.entity_type).toUpperCase();
    if (!(entityTypes as readonly string[]).includes(t)) throw new ApiError(httpStatus.BAD_REQUEST, "entity_type should be SALES_INVOICE or PURCHASE_INVOICE!");
    values.push(t);
    where.push(`it.entity_type = $${values.length}`);
  }
  if (params.entity_id) {
    assertUuid(String(params.entity_id), "entity id");
    values.push(params.entity_id);
    where.push(`it.entity_id = $${values.length}::uuid`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count] = await Promise.all([
    query(`SELECT ${itemColumns} FROM snelstart_sync_items it ${clause} ORDER BY it.created_at DESC, it.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, skip]),
    query(`SELECT COUNT(*)::int AS total FROM snelstart_sync_items it ${clause}`, values),
  ]);
  return paged(rows.rows, count.rows[0].total, page, limit);
};

const getItem = async (id: string) => {
  assertUuid(id, "queue item id");
  const found = await query(`SELECT ${itemColumns} FROM snelstart_sync_items it WHERE it.id = $1::uuid`, [id]);
  if (found.rows.length === 0) throw new ApiError(httpStatus.NOT_FOUND, "Queue item not found!");
  const history = await query(`SELECT id, action, status, message, details, created_at AS "createdAt" FROM snelstart_sync_log WHERE item_id = $1::uuid ORDER BY created_at ASC, id ASC`, [id]);
  return { ...found.rows[0], log: history.rows };
};

const getLog = async (params: Record<string, any>) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const where: string[] = [];
  const values: any[] = [];
  if (params.status) {
    values.push(String(params.status).toUpperCase());
    where.push(`l.status = $${values.length}`);
  }
  if (params.action) {
    values.push(String(params.action).toUpperCase());
    where.push(`l.action = $${values.length}`);
  }
  if (params.entity_type) {
    values.push(String(params.entity_type).toUpperCase());
    where.push(`l.entity_type = $${values.length}`);
  }
  if (params.entity_id) {
    assertUuid(String(params.entity_id), "entity id");
    values.push(params.entity_id);
    where.push(`l.entity_id = $${values.length}::uuid`);
  }
  for (const [key, op] of [["from", ">="], ["to", "<"]] as const) {
    if (params[key]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(params[key]))) throw new ApiError(httpStatus.BAD_REQUEST, `${key} must look like YYYY-MM-DD!`);
      values.push(params[key]);
      where.push(op === ">=" ? `l.created_at >= ($${values.length}::date)::timestamp AT TIME ZONE 'Europe/Amsterdam'` : `l.created_at < (($${values.length}::date + 1)::timestamp AT TIME ZONE 'Europe/Amsterdam')`);
    }
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count] = await Promise.all([
    query(`SELECT l.id, l.item_id, l.entity_type, l.entity_id, l.action, l.status, l.message, l.details, l.created_at AS "createdAt" FROM snelstart_sync_log l ${clause} ORDER BY l.created_at DESC, l.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, skip]),
    query(`SELECT COUNT(*)::int AS total FROM snelstart_sync_log l ${clause}`, values),
  ]);
  return paged(rows.rows, count.rows[0].total, page, limit);
};

// After correcting what was wrong, send it again. It starts where it stopped (a booking that already exists is not made twice).
const retryItem = async (id: string, actorId: string) => {
  assertUuid(id, "queue item id");
  const r = await query(
    `UPDATE snelstart_sync_items SET status = 'PENDING', attempts = 0, next_attempt_at = CURRENT_TIMESTAMP, last_error = NULL, last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1::uuid AND status IN ('FAILED', 'PENDING', 'SKIPPED') RETURNING id, entity_type, entity_id`,
    [id],
  );
  if (r.rows.length === 0) {
    const exists = await query(`SELECT status FROM snelstart_sync_items WHERE id = $1::uuid`, [id]);
    if (exists.rows.length === 0) throw new ApiError(httpStatus.NOT_FOUND, "Queue item not found!");
    throw new ApiError(httpStatus.CONFLICT, `A ${String(exists.rows[0].status).toLowerCase()} record cannot be retried!`);
  }
  await log(r.rows[0], "RETRY_REQUESTED", "INFO", "A person asked to send it again", { by: actorId });
  const s = await settingsRow();
  // sent straight away when the connection is there; otherwise it waits for the next run
  if (s.connection_key_encrypted && s.connection_status === "CONNECTED") await processItem(id);
  return getItem(id);
};

const retryAllFailed = async (actorId: string) => {
  const failed = await query(`SELECT id FROM snelstart_sync_items WHERE status = 'FAILED' ORDER BY created_at`);
  for (const row of failed.rows) {
    await query(`UPDATE snelstart_sync_items SET status = 'PENDING', attempts = 0, next_attempt_at = CURRENT_TIMESTAMP, last_error = NULL, last_error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid AND status = 'FAILED'`, [row.id]);
  }
  if (failed.rows.length > 0) await log(null, "RETRY_REQUESTED", "INFO", `${failed.rows.length} failed record(s) put back in the queue`, { by: actorId });
  return { requeued: failed.rows.length };
};

// A person decided this one is not to be sent (for example the accountant booked it by hand in SnelStart)
const skipItem = async (id: string, reason: string, actorId: string) => {
  assertUuid(id, "queue item id");
  const r = await query(
    `UPDATE snelstart_sync_items SET status = 'SKIPPED', updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid AND status IN ('PENDING', 'FAILED') RETURNING id, entity_type, entity_id`,
    [id],
  );
  if (r.rows.length === 0) throw new ApiError(httpStatus.CONFLICT, "Only a waiting or failed record can be skipped!");
  await log(r.rows[0], "SKIPPED", "INFO", reason, { by: actorId });
  await closeTask(id, "the record was skipped on purpose");
  await logAudit({ actor_id: actorId, action: "UPDATE", entity_type: "snelstart_sync_item", entity_id: id, changes: { to: "SKIPPED", reason } });
  return getItem(id);
};

// Queues records that were issued / approved before the integration was switched on (for the go-live catch-up)
const backfill = async (input: { from: string; to?: string }, actorId: string) => {
  const to = input.to ?? input.from;
  if (input.from > to) throw new ApiError(httpStatus.BAD_REQUEST, "`from` cannot be after `to`!");
  if ((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${input.from}T00:00:00Z`).getTime()) / 86_400_000 > 366) throw new ApiError(httpStatus.BAD_REQUEST, "A period is at most 366 days!");
  const sales = await query(
    `INSERT INTO snelstart_sync_items (entity_type, entity_id, queued_by)
     SELECT 'SALES_INVOICE', i.id, $3::uuid FROM invoices i WHERE i.status = 'ISSUED' AND i.invoice_date BETWEEN $1::date AND $2::date
     ON CONFLICT (entity_type, entity_id) DO NOTHING RETURNING id`,
    [input.from, to, actorId],
  );
  const purchases = await query(
    `INSERT INTO snelstart_sync_items (entity_type, entity_id, queued_by)
     SELECT 'PURCHASE_INVOICE', s.id, $3::uuid FROM supplier_invoices s WHERE s.status IN ('APPROVED', 'PAID') AND s.invoice_date BETWEEN $1::date AND $2::date
     ON CONFLICT (entity_type, entity_id) DO NOTHING RETURNING id`,
    [input.from, to, actorId],
  );
  await log(null, "BACKFILL", "INFO", `Queued ${sales.rows.length} sales and ${purchases.rows.length} purchase invoice(s) from ${input.from} to ${to}`, { by: actorId });
  await logAudit({ actor_id: actorId, action: "CREATE", entity_type: "snelstart_backfill", entity_id: actorId, changes: { from: input.from, to, sales: sales.rows.length, purchases: purchases.rows.length } });
  return { sales_invoices: sales.rows.length, purchase_invoices: purchases.rows.length };
};

export const SnelStartSyncService = { runSync, runIfDue, processItem, getQueue, getItem, getLog, retryItem, retryAllFailed, skipItem, backfill };
export type { TEntityType };
