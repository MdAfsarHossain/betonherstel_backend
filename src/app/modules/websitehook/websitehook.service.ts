import crypto from "crypto";
import httpStatus from "http-status";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { query } from "../../utils/db";
import { decrypt, encrypt } from "../../utils/encryption";
import { InquiryService } from "../inquiry/inquiry.service";
import { addressSchema } from "../inquiry/inquiry.validation";
import {
  crmFields,
  IWebhookResult,
  TCrmField,
  TWebhookStatus,
} from "./websitehook.interface";

// ---------------------------------------------------------------------------
// Settings (FR-HOOK-03)
// ---------------------------------------------------------------------------

const settingsColumns = `secret_encrypted, secret_hint, secret_rotated_at, field_mapping, default_language::text AS default_language, is_active, updated_at`;

const readSettingsRow = async () => {
  const result = await query(
    `SELECT ${settingsColumns} FROM website_webhook_settings WHERE id = TRUE`,
  );
  if (result.rows.length === 0) {
    await query(
      `INSERT INTO website_webhook_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING`,
    );
    return (
      await query(
        `SELECT ${settingsColumns} FROM website_webhook_settings WHERE id = TRUE`,
      )
    ).rows[0];
  }
  return result.rows[0];
};

const endpointUrl = (origin?: string) =>
  `${config.base_url || origin || ""}/webhooks/website`;

const getSettings = async (origin?: string) => {
  const row = await readSettingsRow();
  return {
    endpoint_url: endpointUrl(origin),
    is_active: row.is_active,
    secret_configured: !!row.secret_encrypted,
    secret_hint: row.secret_hint ? `…${row.secret_hint}` : null,
    secret_rotated_at: row.secret_rotated_at,
    default_language: row.default_language,
    mapping: row.field_mapping ?? {},
    crm_fields: crmFields,
    authentication: [
      "Header X-Webhook-Secret: <secret>",
      "Header Authorization: Bearer <secret>",
      "Header X-Webhook-Signature: sha256=<HMAC-SHA256 of the raw request body, hex, key = secret>",
    ],
    updated_at: row.updated_at,
  };
};

const updateSettings = async (
  input: {
    mapping?: Record<string, TCrmField>;
    default_language?: "NL" | "EN";
    is_active?: boolean;
  },
  actorId: string,
  origin?: string,
) => {
  const updates: string[] = [];
  const values: any[] = [];
  let n = 1;
  if (input.mapping !== undefined) {
    updates.push(`field_mapping = $${n++}::jsonb`);
    values.push(JSON.stringify(input.mapping));
  }
  if (input.default_language !== undefined) {
    updates.push(`default_language = $${n++}::"Language"`);
    values.push(input.default_language);
  }
  if (input.is_active !== undefined) {
    updates.push(`is_active = $${n++}`);
    values.push(input.is_active);
  }
  if (updates.length === 0)
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  updates.push(`updated_by = $${n++}::uuid`, `updated_at = CURRENT_TIMESTAMP`);
  values.push(actorId);
  await query(
    `UPDATE website_webhook_settings SET ${updates.join(", ")} WHERE id = TRUE`,
    values,
  );
  await logAudit({
    actor_id: actorId,
    action: "UPDATE",
    entity_type: "website_webhook",
    changes: input,
  });
  return getSettings(origin);
};

// The secret is shown once, here. Only an encrypted copy is stored (the
// signature check needs the real value, so it cannot be a one-way hash).
const regenerateSecret = async (actorId: string) => {
  const secret = `whsec_${crypto.randomBytes(32).toString("hex")}`;
  await readSettingsRow();
  await query(
    `UPDATE website_webhook_settings
     SET secret_encrypted = $1, secret_hint = $2, secret_rotated_at = CURRENT_TIMESTAMP,
         updated_by = $3::uuid, updated_at = CURRENT_TIMESTAMP WHERE id = TRUE`,
    [encrypt(secret), secret.slice(-4), actorId],
  );
  await logAudit({
    actor_id: actorId,
    action: "UPDATE",
    entity_type: "website_webhook",
    changes: { secret: "regenerated" },
  });
  return {
    secret,
    secret_hint: `…${secret.slice(-4)}`,
    note: "Copy this secret now. It is not shown again, and the previous secret no longer works.",
  };
};

// ---------------------------------------------------------------------------
// Authentication (FR-HOOK-02)
// ---------------------------------------------------------------------------

const digest = (v: string) => crypto.createHash("sha256").update(v).digest();
const safeEqual = (a: string, b: string) =>
  crypto.timingSafeEqual(digest(a), digest(b));

const header = (headers: Record<string, any>, name: string): string => {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

export const isAuthentic = (
  secret: string,
  headers: Record<string, any>,
  rawBody: Buffer,
): boolean => {
  const plain = header(headers, "x-webhook-secret");
  if (plain && safeEqual(plain, secret)) return true;
  const bearer = header(headers, "authorization");
  if (
    /^Bearer /i.test(bearer) &&
    safeEqual(bearer.replace(/^Bearer /i, "").trim(), secret)
  )
    return true;
  const sig = header(headers, "x-webhook-signature")
    .replace(/^sha256=/i, "")
    .trim()
    .toLowerCase();
  if (sig) {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    return /^[0-9a-f]{64}$/.test(sig) && safeEqual(sig, expected);
  }
  return false;
};

// ---------------------------------------------------------------------------
// Field mapping (FR-HOOK-03)
// ---------------------------------------------------------------------------

// Names a website form is likely to use. They apply to every CRM field that no
// configured mapping fills, so a simple form works with no setup at all.
const aliases: Record<TCrmField, string[]> = {
  contact_name: ["contact_name", "name", "full_name", "fullname", "naam"],
  contact_email: ["contact_email", "email", "e-mail", "emailadres", "mail"],
  contact_phone: [
    "contact_phone",
    "phone",
    "telephone",
    "tel",
    "telefoon",
    "mobile",
    "phone_number",
  ],
  company_name: ["company_name", "company", "bedrijfsnaam", "bedrijf"],
  relation_type: ["relation_type", "customer_type", "type"],
  service_type: ["service_type", "service", "dienst", "onderwerp", "subject"],
  description: [
    "description",
    "message",
    "bericht",
    "omschrijving",
    "comments",
    "opmerking",
    "opmerkingen",
  ],
  language: ["language", "lang", "taal"],
  street: ["street", "straat"],
  house_number: ["house_number", "housenumber", "huisnummer", "number"],
  postcode: ["postcode", "zip", "zipcode", "postal_code"],
  city: ["city", "plaats", "woonplaats", "stad"],
  country: ["country", "land"],
  external_ref: ["external_ref", "submission_id", "request_id", "delivery_id"],
};
const nameParts = [
  ["first_name", "firstname", "voornaam"],
  ["last_name", "lastname", "achternaam"],
];

const unsafeKey = (k: string) =>
  k === "__proto__" || k === "constructor" || k === "prototype";

// "customer.email" or "items.0.name" reads nested JSON
const readPath = (payload: any, path: string): unknown => {
  let cur: any = payload;
  for (const key of path.split(".")) {
    if (
      unsafeKey(key) ||
      cur === null ||
      typeof cur !== "object" ||
      !Object.prototype.hasOwnProperty.call(cur, key)
    )
      return undefined;
    cur = cur[key];
  }
  return cur;
};

const asText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  let t: string | null = null;
  if (typeof v === "string") t = v;
  else if (typeof v === "number" || typeof v === "boolean") t = String(v);
  else if (Array.isArray(v))
    t = v
      .filter((x) => ["string", "number", "boolean"].includes(typeof x))
      .join(", ");
  t = t?.trim() ?? null;
  return t ? t.slice(0, 5000) : null;
};

export const mapPayload = (payload: any, mapping: Record<string, string>) => {
  const found: Partial<Record<TCrmField, string[]>> = {};
  const add = (field: TCrmField, v: unknown) => {
    const t = asText(v);
    if (t) (found[field] ??= []).push(t);
  };

  for (const [incoming, field] of Object.entries(mapping ?? {})) {
    if ((crmFields as readonly string[]).includes(field))
      add(field as TCrmField, readPath(payload, incoming));
  }
  for (const field of crmFields) {
    if (found[field]?.length) continue;
    for (const alias of aliases[field]) {
      const t = asText(readPath(payload, alias));
      if (t) {
        add(field, t);
        break;
      }
    }
  }
  if (!found.contact_name?.length) {
    const parts = nameParts
      .map((names) =>
        names.map((n) => asText(readPath(payload, n))).find(Boolean),
      )
      .filter(Boolean) as string[];
    if (parts.length) found.contact_name = [parts.join(" ")];
  }

  const fields: Partial<Record<TCrmField, string>> = {};
  for (const field of crmFields) {
    const list = found[field];
    if (!list?.length) continue;
    fields[field] =
      field === "contact_name"
        ? list.join(" ")
        : field === "description"
          ? list.join("\n")
          : list[0];
  }
  return fields;
};

// ---------------------------------------------------------------------------
// From mapped fields to an inquiry
// ---------------------------------------------------------------------------

const relationTypeOf = (v?: string) => {
  const t = (v ?? "").toLowerCase();
  if (["business", "company", "zakelijk", "bedrijf"].includes(t))
    return "BUSINESS" as const;
  if (["private", "particulier", "consumer", "person"].includes(t))
    return "PRIVATE" as const;
  if (t === "vve") return "VVE" as const;
  return undefined;
};

// A lead is never thrown away for a detail that does not fit: what cannot be
// stored as a field is kept as a line in the description.
const buildInquiryInput = async (
  fields: Partial<Record<TCrmField, string>>,
  defaultLanguage: "NL" | "EN",
) => {
  const notes: string[] = [];

  let serviceKey: string | null = null;
  if (fields.service_type) {
    const found = await query(
      `SELECT key FROM service_types
       WHERE is_active AND (key = $1 OR lower(label_nl) = lower($1) OR lower(label_en) = lower($1)) LIMIT 1`,
      [fields.service_type],
    );
    if (found.rows.length > 0) serviceKey = found.rows[0].key;
    else notes.push(`Service: ${fields.service_type}`);
  }

  let address: any = null;
  const hasAddressPart = !!(
    fields.street ||
    fields.house_number ||
    fields.postcode ||
    fields.city
  );
  if (hasAddressPart) {
    const candidate = {
      street: fields.street,
      house_number: fields.house_number,
      postcode: fields.postcode,
      city: fields.city,
      ...(fields.country && /^[A-Za-z]{2}$/.test(fields.country)
        ? { country: fields.country }
        : {}),
    };
    const parsed = addressSchema.safeParse(candidate);
    if (parsed.success) address = parsed.data;
    else
      notes.push(
        `Address: ${[fields.street, fields.house_number].filter(Boolean).join(" ")}, ${[fields.postcode, fields.city].filter(Boolean).join(" ")}`,
      );
  }

  const lang = (fields.language ?? "").toUpperCase();
  const description =
    [fields.description, ...notes].filter(Boolean).join("\n") || null;

  return {
    input: {
      source: "WEBHOOK" as const,
      contact_name: fields.contact_name,
      contact_email: fields.contact_email ?? null,
      contact_phone: fields.contact_phone ?? null,
      company_name: fields.company_name,
      relation_type: relationTypeOf(fields.relation_type),
      service_type: serviceKey,
      description,
      address,
      language: (lang === "NL" || lang === "EN" ? lang : defaultLanguage) as
        | "NL"
        | "EN",
    },
    warnings: notes,
  };
};

// Dry run for the Beheerder: what would this payload become?
const testMapping = async (payload: any) => {
  const row = await readSettingsRow();
  const fields = mapPayload(payload, row.field_mapping ?? {});
  const { input, warnings } = await buildInquiryInput(
    fields,
    row.default_language,
  );
  const problems: string[] = [];
  if (!input.contact_name)
    problems.push("No contact name found: the request would be rejected.");
  if (!input.contact_email && !input.contact_phone)
    problems.push("No email or phone found: the request would be rejected.");
  return {
    mapped_fields: fields,
    inquiry: input,
    warnings,
    problems,
    would_be_accepted: problems.length === 0,
  };
};

// ---------------------------------------------------------------------------
// Receiving a delivery (FR-HOOK-01, 04, 05, 06)
// ---------------------------------------------------------------------------

const summarize = (payload: any) => {
  const out: Record<string, string> = {};
  if (payload && typeof payload === "object") {
    for (const [k, v] of Object.entries(payload).slice(0, 40)) {
      out[k.slice(0, 60)] =
        typeof v === "object" ? "[object]" : String(v).slice(0, 200);
    }
  }
  return out;
};

const writeLog = async (entry: {
  status: TWebhookStatus;
  httpStatus: number;
  inquiryId?: string | null;
  externalRef?: string | null;
  ip?: string;
  contentType?: string;
  payload?: any;
  error?: string | null;
}) => {
  try {
    await query(
      `INSERT INTO website_webhook_log (status, http_status, inquiry_id, external_ref, ip, content_type, payload_summary, error)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8)`,
      [
        entry.status,
        entry.httpStatus,
        entry.inquiryId ?? null,
        entry.externalRef ?? null,
        entry.ip?.slice(0, 64) ?? null,
        entry.contentType?.slice(0, 100) ?? null,
        JSON.stringify(summarize(entry.payload)),
        entry.error?.slice(0, 2000) ?? null,
      ],
    );
  } catch (e: any) {
    console.error(
      "❌ Could not write the website webhook log:",
      e?.message ?? e,
    );
  }
};

// A request that never got as far as being read (broken JSON, too large)
const logRefused = (
  ip: string | undefined,
  contentType: string | undefined,
  httpStatus: number,
  error: string,
) => writeLog({ status: "INVALID", httpStatus, ip, contentType, error });

const receive = async (req: {
  headers: Record<string, any>;
  body: any;
  rawBody: Buffer;
  ip?: string;
  contentType?: string;
}): Promise<IWebhookResult> => {
  const base = { ip: req.ip, contentType: req.contentType, payload: req.body };
  const row = await readSettingsRow();

  let secret: string | null = null;
  try {
    secret = row.secret_encrypted ? decrypt(row.secret_encrypted) : null;
  } catch {
    secret = null;
  }
  if (!secret || !isAuthentic(secret, req.headers, req.rawBody)) {
    await writeLog({
      ...base,
      status: "REJECTED",
      httpStatus: 401,
      error: secret
        ? "Missing or wrong secret or signature"
        : "No secret has been set up yet",
      payload: {},
    });
    return {
      httpStatus: 401,
      body: { success: false, message: "Unauthorized!" },
    };
  }
  if (!row.is_active) {
    await writeLog({
      ...base,
      status: "INACTIVE",
      httpStatus: 403,
      error: "The webhook is switched off",
    });
    return {
      httpStatus: 403,
      body: { success: false, message: "The webhook is switched off!" },
    };
  }
  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    Object.keys(req.body).length === 0
  ) {
    await writeLog({
      ...base,
      status: "INVALID",
      httpStatus: 400,
      error: "Empty or unreadable body",
    });
    return {
      httpStatus: 400,
      body: {
        success: false,
        message: "Send the request data as a JSON object or a form!",
      },
    };
  }

  const fields = mapPayload(req.body, row.field_mapping ?? {});
  // The sender's own delivery id wins; without one, an identical body (a retry) is a duplicate
  const externalRef = (
    header(req.headers, "idempotency-key") ||
    header(req.headers, "x-delivery-id") ||
    fields.external_ref ||
    `body:${crypto.createHash("sha256").update(req.rawBody).digest("hex")}`
  )
    .trim()
    .slice(0, 255);

  try {
    const { input } = await buildInquiryInput(fields, row.default_language);
    const result: any = await InquiryService.createInquiry(
      { ...input, external_ref: externalRef },
      null,
    );

    if (result.created === false && result.reason === "already_received") {
      await writeLog({
        ...base,
        status: "DUPLICATE",
        httpStatus: 200,
        inquiryId: result.inquiry?.id,
        externalRef,
      });
      return {
        httpStatus: 200,
        body: {
          success: true,
          message: "Already received",
          data: {
            id: result.inquiry?.id,
            reference: result.inquiry?.reference,
            duplicate: true,
          },
        },
      };
    }
    await writeLog({
      ...base,
      status: "ACCEPTED",
      httpStatus: 201,
      inquiryId: result.inquiry.id,
      externalRef,
    });
    return {
      httpStatus: 201,
      body: {
        success: true,
        message: "Request received",
        data: {
          id: result.inquiry.id,
          reference: result.inquiry.reference,
          duplicate: false,
        },
      },
    };
  } catch (error: any) {
    if (error instanceof ApiError && error.statusCode < 500) {
      await writeLog({
        ...base,
        status: "INVALID",
        httpStatus: error.statusCode,
        externalRef,
        error: error.message,
      });
      return {
        httpStatus: error.statusCode,
        body: { success: false, message: error.message },
      };
    }
    await writeLog({
      ...base,
      status: "ERROR",
      httpStatus: 500,
      externalRef,
      error: error?.message ?? String(error),
    });
    console.error("❌ Website webhook failed:", error?.message ?? error);
    return {
      httpStatus: 500,
      body: {
        success: false,
        message: "Something went wrong, please try again later!",
      },
    };
  }
};

// ---------------------------------------------------------------------------
// Log (FR-HOOK-05)
// ---------------------------------------------------------------------------

const logColumns = `l.id, l.received_at AS "receivedAt", l.status, l.http_status, l.inquiry_id, l.external_ref, l.ip,
  l.content_type, l.payload_summary, l.error, i.reference AS inquiry_reference`;

const getLogs = async (params: Record<string, any>) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );
  const where: string[] = [];
  const values: any[] = [];
  if (params.status) {
    const list = String(params.status)
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    values.push(list);
    where.push(`l.status = ANY($${values.length}::text[])`);
  }
  for (const [key, op] of [
    ["from", ">="],
    ["to", "<"],
  ] as const) {
    if (params[key]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(params[key])))
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${key} must look like YYYY-MM-DD!`,
        );
      values.push(params[key]);
      where.push(
        op === ">="
          ? `l.received_at >= ($${values.length}::date)::timestamp AT TIME ZONE 'Europe/Amsterdam'`
          : `l.received_at < (($${values.length}::date + 1)::timestamp AT TIME ZONE 'Europe/Amsterdam')`,
      );
    }
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count] = await Promise.all([
    query(
      `SELECT ${logColumns} FROM website_webhook_log l LEFT JOIN inquiries i ON i.id = l.inquiry_id ${clause}
           ORDER BY l.received_at DESC, l.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, skip],
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM website_webhook_log l ${clause}`,
      values,
    ),
  ]);
  const total = count.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: rows.rows,
    meta: {
      page,
      limit,
      total,
      totalPage,
      hasNextPage: page < totalPage,
      hasPrevPage: page > 1,
    },
  };
};

const getLogById = async (id: string) => {
  assertUuid(id, "log id");
  const r = await query(
    `SELECT ${logColumns} FROM website_webhook_log l LEFT JOIN inquiries i ON i.id = l.inquiry_id WHERE l.id = $1::uuid`,
    [id],
  );
  if (r.rows.length === 0)
    throw new ApiError(httpStatus.NOT_FOUND, "Log entry not found!");
  return r.rows[0];
};

// ---------------------------------------------------------------------------
// Documentation and a test example for the website developers (FR-HOOK-07)
// ---------------------------------------------------------------------------

const getExample = (origin?: string) => {
  const url = endpointUrl(origin);
  const body = {
    name: "Jan de Vries",
    email: "jan@example.com",
    phone: "0612345678",
    service: "balcony_renovation",
    message: "The balcony concrete is crumbling.",
    street: "Kerkstraat",
    house_number: "12",
    postcode: "3011 AB",
    city: "Rotterdam",
  };
  return {
    endpoint_url: url,
    method: "POST",
    content_types: ["application/json", "application/x-www-form-urlencoded"],
    authentication:
      "Send the secret in X-Webhook-Secret, or sign the raw body with HMAC-SHA256 and send X-Webhook-Signature: sha256=<hex>.",
    idempotency:
      "Send a unique Idempotency-Key header (or a submission_id field) per submission. A repeated key never creates a second inquiry. Without one, an identical body counts as a repeat.",
    responses: {
      "201": "Inquiry created: { data: { id, reference, duplicate: false } }",
      "200": "Already received: { data: { id, reference, duplicate: true } }",
      "400": "Contact name, or an email or phone number, is missing",
      "401": "Wrong or missing secret / signature",
      "403": "The webhook is switched off",
      "429": "Too many requests",
      "500": "Our error: safe to retry with the same Idempotency-Key",
    },
    sample_body: body,
    curl: `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Webhook-Secret: <YOUR_SECRET>' \\\n  -H 'Idempotency-Key: form-2026-0001' \\\n  -d '${JSON.stringify(body)}'`,
    node_signed: `const crypto = require("crypto");\nconst raw = JSON.stringify(${JSON.stringify(body)});\nconst sig = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(raw).digest("hex");\nawait fetch("${url}", {\n  method: "POST",\n  headers: { "Content-Type": "application/json", "X-Webhook-Signature": "sha256=" + sig, "Idempotency-Key": "form-2026-0001" },\n  body: raw,\n});`,
    html_form_note:
      "A plain HTML form cannot keep a secret. Post from your website server (or a serverless function), never from the visitor's browser.",
  };
};

export const WebsiteHookService = {
  getSettings,
  updateSettings,
  regenerateSecret,
  testMapping,
  receive,
  logRefused,
  getLogs,
  getLogById,
  getExample,
};
