import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { query } from "../../utils/db";
import { encrypt } from "../../utils/encryption";
import { createAutomaticAction } from "../actions/actions.shared";
import { notify } from "../messages/notification.shared";
import { SettingsService } from "../settings/settings.service";
import {
  apiUrl, authUrl, forgetTokens, getToken, ICredentials, loadCredentials, snelstartCall, snelstartList, SnelStartError,
} from "./snelstart.client";
import {
  defaultVatMapping, IVatMapping, lineBtwSoorten, purchaseBtwRegelSoorten, salesBtwRegelSoorten, TLedgerKind,
} from "./snelstart.interface";

// Connecting to SnelStart, the settings, and the mapping of CRM VAT codes and revenue / cost categories to SnelStart
// ledger accounts (FR-SNEL-01, FR-SNEL-02). Nothing in here ever returns a key.

const settingsRow = async () => (await query(`SELECT * FROM snelstart_settings WHERE id = TRUE`)).rows[0];

const adminIds = async (): Promise<string[]> =>
  (await query(`SELECT id FROM users WHERE is_active AND status = 'ACTIVE' AND role::text IN ('ADMIN', 'SUPERADMIN')`)).rows.map((r: any) => r.id);

// ---------------------------------------------------------------------------
// Connection status, with the task and the notification that go with a broken connection
// ---------------------------------------------------------------------------

export const markConnection = async (status: "CONNECTED" | "ERROR" | "DISCONNECTED", error: string | null = null) => {
  const before = await settingsRow();
  await query(
    `UPDATE snelstart_settings
     SET connection_status = $1::varchar, last_error = $2::text, last_checked_at = CURRENT_TIMESTAMP,
         connected_at = CASE WHEN $1::varchar = 'CONNECTED' AND connection_status <> 'CONNECTED' THEN CURRENT_TIMESTAMP ELSE connected_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = TRUE`,
    [status, error],
  );
  if (status === "ERROR") {
    const made = await createAutomaticAction({
      auto_type: "snelstart_sync_error",
      auto_key: "snelstart_sync_error:connection",
      title: "SnelStart connection problem",
      description: `${error ?? "The connection to SnelStart is not working."} Check the connection key in the settings. Records wait in the queue and are sent when it works again.`,
    });
    if (made.created && before?.connection_status !== "ERROR") {
      await notify(await adminIds(), { type: "SNELSTART_SYNC", title: "The SnelStart connection is not working", body: error });
    }
  } else if (status === "CONNECTED") {
    await query(
      `UPDATE actions SET status = 'DONE', completed_at = CURRENT_TIMESTAMP, completion_note = 'Closed automatically: the SnelStart connection works again', updated_at = CURRENT_TIMESTAMP
       WHERE status = 'OPEN' AND auto_type = 'snelstart_sync_error' AND auto_key = 'snelstart_sync_error:connection'`,
    );
  }
};

// ---------------------------------------------------------------------------
// Reading ledger accounts and VAT rates from SnelStart (FR-SNEL-02: "retrieved from SnelStart for selection")
// ---------------------------------------------------------------------------

const ledgerView = (g: any) => ({
  id: String(g.id),
  number: g.nummer ?? null,
  name: g.omschrijving ?? null,
  function: g.grootboekfunctie ?? null,
  cost_centre_required: g.kostenplaatsVerplicht ?? false,
  inactive: !!g.nonactief,
});

const listLedgers = async (includeInactive = false) => {
  const all = (await snelstartList("grootboeken")).map(ledgerView);
  return all.filter((g) => includeInactive || !g.inactive).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
};

const listVatRates = async () =>
  (await snelstartList("btwtarieven", undefined, { maxPages: 3 })).map((t: any) => ({
    kind: t.btwSoort ?? null,
    percentage: t.btwPercentage ?? null,
    from: t.datumVanaf ?? null,
    until: t.datumTotEnMet ?? null,
  }));

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const companyVatRates = async (): Promise<{ code: string; label: string; rate: number; reverse_charge: boolean }[]> =>
  (await SettingsService.getCompanySettings()).vat_rates;

// The CRM VAT codes with what each means in SnelStart: the Beheerder's choice, or a sensible default
export const effectiveVatMapping = async (): Promise<Record<string, IVatMapping & { label: string; rate: number; reverse_charge: boolean; customised: boolean }>> => {
  const [rates, row] = await Promise.all([companyVatRates(), settingsRow()]);
  const stored = (row?.vat_mapping ?? {}) as Record<string, IVatMapping>;
  const out: Record<string, any> = {};
  for (const r of rates) {
    const custom = stored[r.code];
    out[r.code] = { ...(custom ?? defaultVatMapping(r.code, r.rate, r.reverse_charge)), label: r.label, rate: r.rate, reverse_charge: r.reverse_charge, customised: !!custom };
  }
  return out;
};

export const vatMappingFor = async (code: string): Promise<IVatMapping> => {
  const all = await effectiveVatMapping();
  const m = all[code];
  if (!m) throw new SnelStartError("VALIDATION", `VAT code ${code} is not a known CRM VAT code.`);
  return { line_btw_soort: m.line_btw_soort, sales_btw_regel_soort: m.sales_btw_regel_soort, purchase_btw_regel_soort: m.purchase_btw_regel_soort };
};

const ledgerRows = async () =>
  (
    await query(
      `SELECT id, kind, vat_code, service_type_key, grootboek_id, grootboek_number, grootboek_name, updated_at AS "updatedAt"
       FROM snelstart_ledger_map ORDER BY kind, vat_code, service_type_key NULLS FIRST`,
    )
  ).rows;

// Which ledger account a booking line goes to: the one for its category (service type) when there is one, else the
// one for its VAT code
export const resolveLedger = async (kind: TLedgerKind, vatCode: string, serviceTypeKey: string | null) => {
  const found = await query(
    `SELECT grootboek_id, grootboek_number, grootboek_name FROM snelstart_ledger_map
     WHERE kind = $1 AND vat_code = $2 AND (service_type_key = $3 OR service_type_key IS NULL)
     ORDER BY service_type_key NULLS LAST LIMIT 1`,
    [kind, vatCode, serviceTypeKey],
  );
  if (found.rows.length === 0) {
    throw new SnelStartError(
      "VALIDATION",
      `No SnelStart ledger account is mapped for ${kind === "REVENUE" ? "revenue" : "costs"} with VAT code ${vatCode}${serviceTypeKey ? ` (category ${serviceTypeKey})` : ""}. Add it under Settings > SnelStart > mapping, then retry.`,
    );
  }
  return found.rows[0] as { grootboek_id: string; grootboek_number: number | null; grootboek_name: string | null };
};

const getReadiness = async () => {
  const [row, rates, ledgers] = await Promise.all([settingsRow(), companyVatRates(), ledgerRows()]);
  const problems: string[] = [];
  const warnings: string[] = [];
  const hasKey = !!row?.connection_key_encrypted;
  if (!hasKey) problems.push("Add the SnelStart connection key.");
  else if (row.connection_status !== "CONNECTED") problems.push("The SnelStart connection is not working. Check the connection key.");
  if (!ledgers.some((l: any) => l.kind === "REVENUE")) problems.push("Map at least one revenue ledger account.");
  if (!ledgers.some((l: any) => l.kind === "COST")) problems.push("Map at least one cost ledger account.");
  for (const r of rates) {
    for (const kind of ["REVENUE", "COST"] as const) {
      if (!ledgers.some((l: any) => l.kind === kind && l.vat_code === r.code && l.service_type_key == null)) {
        warnings.push(`No ${kind === "REVENUE" ? "revenue" : "cost"} ledger account for VAT code ${r.code}: ${kind === "REVENUE" ? "invoices" : "supplier invoices"} with this code will fail until it is mapped.`);
      }
    }
  }
  return { ok: problems.length === 0, problems, warnings };
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const getStatus = async () => {
  const [row, readiness, counts] = await Promise.all([
    settingsRow(),
    getReadiness(),
    query(`SELECT status, COUNT(*)::int AS n FROM snelstart_sync_items GROUP BY status`),
  ]);
  const byStatus = Object.fromEntries(counts.rows.map((r: any) => [r.status, r.n]));
  const credentials = row.connection_key_encrypted ? await loadCredentials().catch(() => null) : null;
  return {
    connection: {
      status: row.connection_status,
      connected: row.connection_status === "CONNECTED",
      key_hint: row.key_hint ? `…${row.key_hint}` : null,
      subscription_key: credentials ? credentials.subscriptionSource : process.env.SNELSTART_SUBSCRIPTION_KEY ? "environment" : null,
      connected_at: row.connected_at,
      last_checked_at: row.last_checked_at,
      last_error: row.last_error,
    },
    sync: {
      enabled: row.is_enabled,
      interval_minutes: row.sync_interval_minutes,
      last_sync_at: row.last_sync_at,
      paused_until: row.retry_after && new Date(row.retry_after) > new Date() ? row.retry_after : null,
    },
    queue: {
      pending: byStatus.PENDING ?? 0,
      sending: byStatus.SENDING ?? 0,
      sent: byStatus.SENT ?? 0,
      failed: byStatus.FAILED ?? 0,
      skipped: byStatus.SKIPPED ?? 0,
      cancelled: byStatus.CANCELLED ?? 0,
    },
    readiness,
    api: { base_url: apiUrl(), token_url: authUrl() },
  };
};

// ---------------------------------------------------------------------------
// Connecting (FR-SNEL-01)
// ---------------------------------------------------------------------------

// Checks the keys with SnelStart (a token, then one light call) before anything is saved, so a typo is caught now
const verify = async (credentials: ICredentials) => {
  await getToken(credentials, true);
  await snelstartCall("GET", "grootboeken", { query: { $top: 1 }, credentials });
};

const connect = async (input: { connection_key: string; subscription_key?: string }, actorId: string) => {
  const connectionKey = input.connection_key.trim();
  const subscriptionKey = input.subscription_key?.trim() || process.env.SNELSTART_SUBSCRIPTION_KEY || "";
  if (!subscriptionKey) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The SnelStart subscription key is missing. Send `subscription_key`, or set SNELSTART_SUBSCRIPTION_KEY on the server!");
  }
  try {
    await verify({ connectionKey, subscriptionKey, subscriptionSource: input.subscription_key ? "database" : "environment" });
  } catch (error: any) {
    if (error instanceof SnelStartError) {
      throw new ApiError(error.kind === "TEMPORARY" || error.kind === "RATE_LIMIT" ? httpStatus.BAD_GATEWAY : httpStatus.CONFLICT, error.message);
    }
    throw error;
  }

  await query(
    `UPDATE snelstart_settings
     SET connection_key_encrypted = $1, subscription_key_encrypted = $2, key_hint = $3, updated_by = $4::uuid, updated_at = CURRENT_TIMESTAMP
     WHERE id = TRUE`,
    [encrypt(connectionKey), input.subscription_key?.trim() ? encrypt(subscriptionKey) : null, connectionKey.slice(-4), actorId],
  );
  forgetTokens();
  await markConnection("CONNECTED", null);
  // The keys themselves are never written to the audit log
  await logAudit({ actor_id: actorId, action: "UPDATE", entity_type: "snelstart_settings", entity_id: actorId, changes: { connected: true } });
  return getStatus();
};

// Asks SnelStart again, for example after the accountant generated a new key or SnelStart was down
const testConnection = async () => {
  const credentials = await loadCredentials();
  if (!credentials) throw new ApiError(httpStatus.CONFLICT, "SnelStart is not connected. Add the connection key first!");
  try {
    await verify(credentials);
    await markConnection("CONNECTED", null);
  } catch (error: any) {
    if (error instanceof SnelStartError) {
      await markConnection("ERROR", error.message);
      return getStatus();
    }
    throw error;
  }
  return getStatus();
};

const disconnect = async (actorId: string) => {
  const row = await settingsRow();
  if (!row.connection_key_encrypted) throw new ApiError(httpStatus.NOT_FOUND, "SnelStart is not connected!");
  await query(
    `UPDATE snelstart_settings
     SET connection_key_encrypted = NULL, subscription_key_encrypted = NULL, key_hint = NULL, is_enabled = FALSE,
         connection_status = 'DISCONNECTED', last_error = NULL, updated_by = $1::uuid, updated_at = CURRENT_TIMESTAMP
     WHERE id = TRUE`,
    [actorId],
  );
  forgetTokens();
  await logAudit({ actor_id: actorId, action: "DELETE", entity_type: "snelstart_settings", entity_id: actorId, changes: { disconnected: true } });
  return getStatus();
};

// Switch the synchronisation on or off, and how often it runs (FR-SNEL-06)
const updateSettings = async (input: { is_enabled?: boolean; sync_interval_minutes?: number }, actorId: string) => {
  const row = await settingsRow();
  if (input.is_enabled === true) {
    const readiness = await getReadiness();
    if (!readiness.ok) throw new ApiError(httpStatus.CONFLICT, `SnelStart cannot be switched on yet: ${readiness.problems.join(" ")}`);
  }
  const updates: string[] = [];
  const values: any[] = [];
  if (input.is_enabled !== undefined) { values.push(input.is_enabled); updates.push(`is_enabled = $${values.length}`); }
  if (input.sync_interval_minutes !== undefined) { values.push(input.sync_interval_minutes); updates.push(`sync_interval_minutes = $${values.length}`); }
  if (updates.length === 0) throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  values.push(actorId);
  await query(`UPDATE snelstart_settings SET ${updates.join(", ")}, updated_by = $${values.length}::uuid, updated_at = CURRENT_TIMESTAMP WHERE id = TRUE`, values);
  await logAudit({ actor_id: actorId, action: "UPDATE", entity_type: "snelstart_settings", entity_id: actorId, changes: { ...input, was_enabled: row.is_enabled } });
  return getStatus();
};

// ---------------------------------------------------------------------------
// Mapping endpoints
// ---------------------------------------------------------------------------

const getMapping = async () => {
  const [vat, ledgers, readiness, serviceTypes] = await Promise.all([
    effectiveVatMapping(),
    ledgerRows(),
    getReadiness(),
    query(`SELECT key, label_nl, label_en FROM service_types WHERE is_active ORDER BY sort_order, key`),
  ]);
  return {
    vat: Object.entries(vat).map(([code, m]) => ({ code, ...m })),
    ledgers: ledgers.map((l: any) => ({ id: l.id, kind: l.kind, vat_code: l.vat_code, service_type: l.service_type_key, grootboek_id: l.grootboek_id, number: l.grootboek_number, name: l.grootboek_name, updatedAt: l.updatedAt })),
    service_types: serviceTypes.rows,
    options: { line_btw_soort: lineBtwSoorten, sales_btw_regel_soort: salesBtwRegelSoorten, purchase_btw_regel_soort: purchaseBtwRegelSoorten },
    readiness,
  };
};

const setVatMapping = async (items: { vat_code: string; line_btw_soort: any; sales_btw_regel_soort: any; purchase_btw_regel_soort: any }[], actorId: string) => {
  const rates = await companyVatRates();
  const codes = new Set(rates.map((r) => r.code));
  const row = await settingsRow();
  const stored = { ...((row.vat_mapping ?? {}) as Record<string, IVatMapping>) };
  for (const item of items) {
    if (!codes.has(item.vat_code)) throw new ApiError(httpStatus.BAD_REQUEST, `Unknown VAT code ${item.vat_code}!`);
    stored[item.vat_code] = { line_btw_soort: item.line_btw_soort, sales_btw_regel_soort: item.sales_btw_regel_soort, purchase_btw_regel_soort: item.purchase_btw_regel_soort };
  }
  await query(`UPDATE snelstart_settings SET vat_mapping = $1::jsonb, updated_by = $2::uuid, updated_at = CURRENT_TIMESTAMP WHERE id = TRUE`, [JSON.stringify(stored), actorId]);
  await logAudit({ actor_id: actorId, action: "UPDATE", entity_type: "snelstart_mapping", entity_id: actorId, changes: { vat: items } });
  return getMapping();
};

const setLedgerMapping = async (items: { kind: TLedgerKind; vat_code: string; service_type?: string | null; grootboek_id: string }[], actorId: string) => {
  const rates = await companyVatRates();
  const codes = new Set(rates.map((r) => r.code));
  // The accounts are checked against SnelStart itself, so a wrong id is caught here and not at the first invoice
  const live = new Map((await listLedgers(true)).map((g) => [g.id, g]));
  for (const item of items) {
    if (!codes.has(item.vat_code)) throw new ApiError(httpStatus.BAD_REQUEST, `Unknown VAT code ${item.vat_code}!`);
    if (item.service_type) {
      if (item.kind !== "REVENUE") throw new ApiError(httpStatus.BAD_REQUEST, "A category can only be mapped for revenue!");
      const st = await query(`SELECT 1 FROM service_types WHERE key = $1`, [item.service_type]);
      if (st.rows.length === 0) throw new ApiError(httpStatus.BAD_REQUEST, `Unknown category ${item.service_type}!`);
    }
    const g = live.get(item.grootboek_id);
    if (!g) throw new ApiError(httpStatus.BAD_REQUEST, "That ledger account does not exist in SnelStart!");
    if (g.inactive) throw new ApiError(httpStatus.BAD_REQUEST, `Ledger account ${g.number} ${g.name} is inactive in SnelStart!`);
  }
  for (const item of items) {
    const g = live.get(item.grootboek_id)!;
    await query(
      `INSERT INTO snelstart_ledger_map (kind, vat_code, service_type_key, grootboek_id, grootboek_number, grootboek_name, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)
       ON CONFLICT (kind, vat_code, COALESCE(service_type_key, ''))
       DO UPDATE SET grootboek_id = EXCLUDED.grootboek_id, grootboek_number = EXCLUDED.grootboek_number, grootboek_name = EXCLUDED.grootboek_name,
                     updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
      [item.kind, item.vat_code, item.service_type ?? null, g.id, g.number, g.name, actorId],
    );
  }
  await logAudit({ actor_id: actorId, action: "UPDATE", entity_type: "snelstart_mapping", entity_id: actorId, changes: { ledgers: items } });
  return getMapping();
};

const deleteLedgerMapping = async (id: string, actorId: string) => {
  assertUuid(id, "mapping id");
  const removed = await query(`DELETE FROM snelstart_ledger_map WHERE id = $1::uuid RETURNING kind, vat_code`, [id]);
  if (removed.rows.length === 0) throw new ApiError(httpStatus.NOT_FOUND, "Mapping not found!");
  await logAudit({ actor_id: actorId, action: "DELETE", entity_type: "snelstart_mapping", entity_id: id, changes: removed.rows[0] });
  return getMapping();
};

export const SnelStartSettingsService = {
  getStatus, connect, testConnection, disconnect, updateSettings, listLedgers, listVatRates, getMapping, setVatMapping, setLedgerMapping, deleteLedgerMapping, getReadiness,
};
