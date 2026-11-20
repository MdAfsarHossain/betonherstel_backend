import crypto from "crypto";
import { query } from "../../utils/db";
import { decrypt } from "../../utils/encryption";

// A small client for the SnelStart B2B API v2, and the one place that knows how to talk to it.
// Facts it is built on (SnelStart's own docs are behind the developer-portal login, so these come from the
// public integration guides and open-source client libraries and are VERIFIED AGAINST THE DEVELOPMENT
// SUBSCRIPTION before go-live, see docs/SNELSTART.md):
//   - the connection key (maatwerksleutel) is exchanged for a bearer token that lasts about an hour:
//         POST https://auth.snelstart.nl/b2b/token   (form: grant_type=clientkey&clientkey=<key>)
//   - every API call carries two headers: `Ocp-Apim-Subscription-Key` (the integration's key from the SnelStart
//     developer portal) and `Authorization: Bearer <token>`
//   - the API is https://b2bapi.snelstart.nl/v2/ ; lists use OData ($filter, $top, $skip)
// The keys are stored encrypted and are never returned by the API (NFR-SEC-07).

const defaultApiUrl = "https://b2bapi.snelstart.nl/v2";
const defaultAuthUrl = "https://auth.snelstart.nl/b2b/token";

export const apiUrl = () => (process.env.SNELSTART_API_URL || defaultApiUrl).replace(/\/+$/, "");
export const authUrl = () => process.env.SNELSTART_AUTH_URL || defaultAuthUrl;
// SnelStart limits calls (development subscription: about 100 a minute): calls are spaced out
const minIntervalMs = () => Number(process.env.SNELSTART_MIN_INTERVAL_MS ?? 700);

export interface ISnelStartRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export type TSnelStartTransport = (request: ISnelStartRequest) => Promise<{ status: number; body: any; headers?: Record<string, string> }>;

const fetchTransport: TSnelStartTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 300) };
  }
  return { status: response.status, body, headers: { "retry-after": response.headers.get("retry-after") ?? "" } };
};

let transport: TSnelStartTransport = fetchTransport;

// Lets tests (and local development) stand in for SnelStart
export const setSnelStartTransport = (custom: TSnelStartTransport | null) => {
  transport = custom ?? fetchTransport;
  tokens.clear();
};

// What went wrong, in terms of what to do about it
export type TSnelStartErrorKind =
  | "NOT_CONFIGURED" // no keys saved
  | "AUTH" // the key or the subscription was refused: a person must fix the connection
  | "RATE_LIMIT" // too many calls: wait
  | "VALIDATION" // SnelStart rejected the data: a person must correct it
  | "NOT_FOUND"
  | "TEMPORARY"; // SnelStart is down, slow or unreachable: try again later

export class SnelStartError extends Error {
  constructor(
    public kind: TSnelStartErrorKind,
    message: string,
    public status: number = 0,
    public retryAfterSeconds: number | null = null,
    public details: any = null,
  ) {
    super(message);
  }
  // A problem that fixes itself with time
  get retryable() {
    return this.kind === "TEMPORARY" || this.kind === "RATE_LIMIT";
  }
}

// SnelStart answers a rejected request in one of a few shapes: { modelState: { field: [messages] } },
// [{ errorCode, message }] or { Message } / { message }
const describeError = (body: any, fallback: string): string => {
  try {
    if (body?.modelState && typeof body.modelState === "object") {
      return Object.entries(body.modelState).map(([field, msgs]) => `${field}: ${(msgs as string[]).join(", ")}`).join("; ").slice(0, 600);
    }
    if (Array.isArray(body)) return body.map((e) => [e?.errorCode, e?.message].filter(Boolean).join(" ")).join("; ").slice(0, 600) || fallback;
    return String(body?.Message ?? body?.message ?? body?.error_description ?? body?.error ?? fallback).slice(0, 600);
  } catch {
    return fallback;
  }
};

const classify = (status: number, body: any, headers?: Record<string, string>): SnelStartError => {
  const text = describeError(body, `SnelStart answered HTTP ${status}`);
  if (status === 401 || status === 403) return new SnelStartError("AUTH", `SnelStart refused the connection (${status}): ${text}`, status);
  if (status === 429) {
    const wait = Number(headers?.["retry-after"]);
    return new SnelStartError("RATE_LIMIT", `SnelStart rate limit reached: ${text}`, status, Number.isFinite(wait) && wait > 0 ? wait : 60);
  }
  if (status === 404) return new SnelStartError("NOT_FOUND", text, status);
  if (status >= 500) return new SnelStartError("TEMPORARY", `SnelStart is not available right now (${status}): ${text}`, status);
  return new SnelStartError("VALIDATION", text, status, null, body);
};

// ---------------------------------------------------------------------------
// Credentials and the token
// ---------------------------------------------------------------------------

export interface ICredentials {
  connectionKey: string;
  subscriptionKey: string;
  subscriptionSource: "database" | "environment";
}

export const loadCredentials = async (): Promise<ICredentials | null> => {
  const row = await query(`SELECT connection_key_encrypted, subscription_key_encrypted FROM snelstart_settings WHERE id = TRUE`);
  const saved = row.rows[0];
  if (!saved?.connection_key_encrypted) return null;
  const fromDb = saved.subscription_key_encrypted ? decrypt(saved.subscription_key_encrypted) : null;
  const subscriptionKey = fromDb ?? process.env.SNELSTART_SUBSCRIPTION_KEY ?? null;
  if (!subscriptionKey) return null;
  return { connectionKey: decrypt(saved.connection_key_encrypted), subscriptionKey, subscriptionSource: fromDb ? "database" : "environment" };
};

const tokens = new Map<string, { token: string; type: string; expiresAt: number }>();
const keyId = (c: { connectionKey: string }) => crypto.createHash("sha256").update(c.connectionKey).digest("hex");

const send = async (request: ISnelStartRequest) => {
  try {
    return await transport(request);
  } catch (error: any) {
    throw new SnelStartError("TEMPORARY", `SnelStart could not be reached: ${error?.message ?? "network error"}`);
  }
};

export const getToken = async (credentials: ICredentials, forceNew = false) => {
  const id = keyId(credentials);
  const cached = tokens.get(id);
  if (!forceNew && cached && cached.expiresAt > Date.now() + 60_000) return cached;

  const result = await send({
    method: "POST",
    url: authUrl(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "clientkey", clientkey: credentials.connectionKey }).toString(),
  });
  if (result.status < 200 || result.status >= 300 || !result.body?.access_token) {
    // a wrong or revoked connection key is always the person's to fix
    const kind = result.status >= 500 ? "TEMPORARY" : result.status === 429 ? "RATE_LIMIT" : "AUTH";
    throw new SnelStartError(kind, `SnelStart did not accept the connection key (${result.status}): ${describeError(result.body, "no token returned")}`, result.status);
  }
  const entry = {
    token: String(result.body.access_token),
    type: String(result.body.token_type || "Bearer"),
    expiresAt: Date.now() + Math.max(60, Number(result.body.expires_in) || 3600) * 1000,
  };
  tokens.set(id, entry);
  return entry;
};

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

let lastCallAt = 0;
const throttle = async () => {
  const wait = lastCallAt + minIntervalMs() - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
};

export const querystring = (params?: Record<string, string | number | undefined>) => {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== "");
  return entries.length ? `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}` : "";
};

export interface ICallOptions {
  query?: Record<string, string | number | undefined>;
  body?: any;
  credentials?: ICredentials;
}

export const snelstartCall = async (method: string, path: string, options: ICallOptions = {}) => {
  const credentials = options.credentials ?? (await loadCredentials());
  if (!credentials) throw new SnelStartError("NOT_CONFIGURED", "SnelStart is not connected. An admin can add the connection key in the settings!");

  const attempt = async (forceNewToken: boolean) => {
    const token = await getToken(credentials, forceNewToken);
    await throttle();
    return send({
      method,
      url: `${apiUrl()}/${path.replace(/^\/+/, "")}${querystring(options.query)}`,
      headers: {
        "Ocp-Apim-Subscription-Key": credentials.subscriptionKey,
        Authorization: `${token.type} ${token.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  };

  let result = await attempt(false);
  // an expired token: get a new one once
  if (result.status === 401) result = await attempt(true);
  if (result.status < 200 || result.status >= 300) throw classify(result.status, result.body, result.headers);
  return result.body;
};

// A list answers an array, or an object with the items inside
export const asList = (body: any): any[] => (Array.isArray(body) ? body : (body?.value ?? body?.items ?? body?.results ?? []));

// Reads every page of a list (OData $top / $skip), up to a safe limit
export const snelstartList = async (path: string, filter?: string, options: { pageSize?: number; maxPages?: number; credentials?: ICredentials } = {}) => {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 30;
  const out: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const body = await snelstartCall("GET", path, { query: { $filter: filter, $top: pageSize, $skip: page * pageSize }, credentials: options.credentials });
    const items = asList(body);
    out.push(...items);
    if (items.length < pageSize) break;
  }
  return out;
};

// OData string literals double their single quotes
export const odataString = (value: string) => `'${String(value).replace(/'/g, "''")}'`;

export const forgetTokens = () => tokens.clear();
