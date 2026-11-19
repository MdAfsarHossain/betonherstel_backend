import httpStatus from "http-status";
import ApiError from "../errors/ApiError";
import { logAudit } from "../utils/audit";
import { query } from "../utils/db";
import { decrypt, encrypt } from "../utils/encryption";

// A small client for the Mollie payments API (SRS 8.1) and the place where the API key is
// kept (FR-SET-05). The key is stored encrypted and is never returned by the API
// (NFR-SEC-07). Card and bank details never reach the CRM: Mollie handles the payment
// (NFR-SEC-05); we only create a payment, send the customer to Mollie's checkout page and
// read back the result.

const API_BASE = "https://api.mollie.com/v2";
const KEY_PATTERN = /^(test|live)_[A-Za-z0-9]{20,}$/;

export interface IMollieRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
}

export type TMollieTransport = (request: IMollieRequest) => Promise<{ status: number; body: any }>;

const fetchTransport: TMollieTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { detail: text.slice(0, 200) };
  }
  return { status: response.status, body };
};

let transport: TMollieTransport = fetchTransport;

// Lets tests (and local development) stand in for Mollie
export const setMollieTransport = (custom: TMollieTransport | null) => {
  transport = custom ?? fetchTransport;
};

export interface IMollieConfig {
  key: string;
  mode: "test" | "live";
  source: "database" | "environment";
}

// The key saved by an admin wins; MOLLIE_API_KEY in the environment is the fallback
const getConfig = async (): Promise<IMollieConfig | null> => {
  const saved = await query(`SELECT api_key_encrypted, mode FROM mollie_settings WHERE id = true`);
  if (saved.rows.length > 0) {
    return { key: decrypt(saved.rows[0].api_key_encrypted), mode: saved.rows[0].mode, source: "database" };
  }
  const env = process.env.MOLLIE_API_KEY;
  if (env && KEY_PATTERN.test(env)) {
    return { key: env, mode: env.startsWith("live_") ? "live" : "test", source: "environment" };
  }
  return null;
};

const request = async (method: string, path: string, body?: any, config?: IMollieConfig | null) => {
  const mollie = config ?? (await getConfig());
  if (!mollie) {
    throw new ApiError(httpStatus.CONFLICT, "Mollie is not connected. An admin can add the API key in the settings!");
  }

  let result: { status: number; body: any };
  try {
    result = await transport({
      method,
      url: `${API_BASE}${path}`,
      headers: { Authorization: `Bearer ${mollie.key}`, "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
  } catch (error: any) {
    throw new ApiError(httpStatus.BAD_GATEWAY, "Mollie could not be reached. Try again in a moment!");
  }

  if (result.status < 200 || result.status >= 300) {
    const detail = result.body?.detail ?? result.body?.title ?? `HTTP ${result.status}`;
    // A bad or revoked key is the admin's to fix; anything else is Mollie's side
    throw new ApiError(
      result.status === 401 ? httpStatus.CONFLICT : result.status === 404 ? httpStatus.NOT_FOUND : httpStatus.BAD_GATEWAY,
      result.status === 401 ? "Mollie refused the API key. Check it in the settings!" : `Mollie: ${detail}`,
    );
  }
  return result.body;
};

// Mollie wants amounts as strings with two decimals
const mollieAmount = (cents: number) => ({ currency: "EUR", value: (cents / 100).toFixed(2) });

const getStatus = async () => {
  const saved = await query(`SELECT mode, key_hint, updated_at FROM mollie_settings WHERE id = true`);
  if (saved.rows.length > 0) {
    return { configured: true, mode: saved.rows[0].mode, source: "database", key_hint: saved.rows[0].key_hint, updatedAt: saved.rows[0].updated_at };
  }
  const env = await getConfig();
  if (env) {
    return { configured: true, mode: env.mode, source: "environment", key_hint: env.key.slice(-4), updatedAt: null };
  }
  return { configured: false, mode: null, source: null, key_hint: null, updatedAt: null };
};

const saveKey = async (apiKey: string, actorId: string) => {
  const key = apiKey.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "That does not look like a Mollie API key (test_... or live_...)!");
  }
  const mode = key.startsWith("live_") ? "live" : "test";

  // Check it with Mollie before saving, so a typo is caught now and not at the first invoice
  await request("GET", "/methods", undefined, { key, mode, source: "database" });

  await query(
    `
      INSERT INTO mollie_settings (id, api_key_encrypted, mode, key_hint, updated_by, updated_at)
      VALUES (true, $1, $2, $3, $4::uuid, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE
      SET api_key_encrypted = EXCLUDED.api_key_encrypted, mode = EXCLUDED.mode, key_hint = EXCLUDED.key_hint,
          updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
    `,
    [encrypt(key), mode, key.slice(-4), actorId],
  );
  // The key itself is never written to the audit log
  await logAudit({ actor_id: actorId, action: "UPDATE", entity_type: "mollie_settings", entity_id: actorId, changes: { mode } });
  return getStatus();
};

const removeKey = async (actorId: string) => {
  const removed = await query(`DELETE FROM mollie_settings WHERE id = true RETURNING mode`);
  if (removed.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "No Mollie key is saved!");
  }
  await logAudit({ actor_id: actorId, action: "DELETE", entity_type: "mollie_settings", entity_id: actorId, changes: { mode: removed.rows[0].mode } });
  return getStatus();
};

// The payment methods switched on in the client's Mollie account (FR-INV-08)
const testConnection = async () => {
  const config = await getConfig();
  const body = await request("GET", "/methods", undefined, config);
  const methods = (body?._embedded?.methods ?? []).map((m: any) => ({ id: m.id, description: m.description }));
  return { mode: config?.mode, methods };
};

export interface ICreateMolliePayment {
  amountCents: number;
  description: string;
  redirectUrl: string;
  webhookUrl?: string;
  metadata: Record<string, string>;
}

const createPayment = async (input: ICreateMolliePayment) => {
  const body = await request("POST", "/payments", {
    amount: mollieAmount(input.amountCents),
    description: input.description,
    redirectUrl: input.redirectUrl,
    ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
    metadata: input.metadata,
  });
  const checkoutUrl = body?._links?.checkout?.href;
  if (!body?.id || !checkoutUrl) {
    throw new ApiError(httpStatus.BAD_GATEWAY, "Mollie did not return a payment link!");
  }
  return { id: String(body.id), status: String(body.status ?? "open"), checkoutUrl: String(checkoutUrl) };
};

export interface IMolliePayment {
  id: string;
  status: string;
  amountCents: number;
  paidAt: string | null;
  metadata: Record<string, any>;
  // A direct debit the bank took back after it was paid
  chargedBackCents: number;
  customerId: string | null;
  mandateId: string | null;
  failureReason: string | null;
}

const getPayment = async (id: string): Promise<IMolliePayment> => {
  const body = await request("GET", `/payments/${encodeURIComponent(id)}`);
  const value = Number(body?.amount?.value);
  return {
    id: String(body.id),
    status: String(body.status),
    amountCents: Number.isFinite(value) ? Math.round(value * 100) : 0,
    paidAt: body.paidAt ?? null,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    chargedBackCents: Math.round(Number(body?.amountChargedBack?.value ?? 0) * 100) || 0,
    customerId: body.customerId ?? null,
    mandateId: body.mandateId ?? null,
    failureReason: body?.details?.failureReason ?? body?.details?.bankReasonCode ?? null,
  };
};

// ---------------------------------------------------------------------------
// SEPA direct debit (FR-ABO-03): a customer, a first payment that creates the mandate, and
// recurring payments that use it
// ---------------------------------------------------------------------------

const createCustomer = async (input: { name: string; email?: string | null; metadata?: Record<string, string> }) => {
  const body = await request("POST", "/customers", {
    name: input.name,
    ...(input.email ? { email: input.email } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  if (!body?.id) throw new ApiError(httpStatus.BAD_GATEWAY, "Mollie did not return a customer!");
  return String(body.id);
};

// The customer pays a small amount (for example through iDEAL); Mollie then holds a SEPA mandate
const createFirstPayment = async (input: {
  customerId: string;
  amountCents: number;
  description: string;
  redirectUrl: string;
  webhookUrl?: string;
  metadata: Record<string, string>;
}) => {
  const body = await request("POST", "/payments", {
    amount: mollieAmount(input.amountCents),
    description: input.description,
    redirectUrl: input.redirectUrl,
    ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
    customerId: input.customerId,
    sequenceType: "first",
    metadata: input.metadata,
  });
  const checkoutUrl = body?._links?.checkout?.href;
  if (!body?.id || !checkoutUrl) throw new ApiError(httpStatus.BAD_GATEWAY, "Mollie did not return a payment link!");
  return { id: String(body.id), status: String(body.status ?? "open"), checkoutUrl: String(checkoutUrl) };
};

const createRecurringPayment = async (input: {
  customerId: string;
  mandateId: string;
  amountCents: number;
  description: string;
  webhookUrl?: string;
  metadata: Record<string, string>;
}) => {
  const body = await request("POST", "/payments", {
    amount: mollieAmount(input.amountCents),
    description: input.description,
    ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
    customerId: input.customerId,
    mandateId: input.mandateId,
    sequenceType: "recurring",
    metadata: input.metadata,
  });
  if (!body?.id) throw new ApiError(httpStatus.BAD_GATEWAY, "Mollie did not create the direct debit!");
  return { id: String(body.id), status: String(body.status ?? "open") };
};

export interface IMollieMandate {
  id: string;
  status: string;
  method: string | null;
  consumerName: string | null;
  consumerAccountHint: string | null;
  createdAt: string | null;
}

const listMandates = async (customerId: string): Promise<IMollieMandate[]> => {
  const body = await request("GET", `/customers/${encodeURIComponent(customerId)}/mandates`);
  return (body?._embedded?.mandates ?? []).map((m: any) => {
    // Only the last four characters of the account are kept
    const account = String(m?.details?.consumerAccount ?? "");
    return {
      id: String(m.id),
      status: String(m.status),
      method: m.method ?? null,
      consumerName: m?.details?.consumerName ?? null,
      consumerAccountHint: account ? `…${account.slice(-4)}` : null,
      createdAt: m.createdAt ?? null,
    };
  });
};

// Best effort: the old mandate should stop working once a new one replaces it
const revokeMandate = async (customerId: string, mandateId: string) => {
  try {
    await request("DELETE", `/customers/${encodeURIComponent(customerId)}/mandates/${encodeURIComponent(mandateId)}`);
  } catch {
    // already revoked or not revocable: nothing to do
  }
};

// Best effort: an open link should not stay payable once the invoice is settled
const cancelPayment = async (id: string) => {
  try {
    await request("DELETE", `/payments/${encodeURIComponent(id)}`);
  } catch {
    // already paid, expired or not cancelable: nothing to do
  }
};

export const MollieService = {
  getConfig,
  getStatus,
  saveKey,
  removeKey,
  testConnection,
  createPayment,
  getPayment,
  cancelPayment,
  createCustomer,
  createFirstPayment,
  createRecurringPayment,
  listMandates,
  revokeMandate,
};
