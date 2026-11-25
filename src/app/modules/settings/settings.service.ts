import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { S3Uploader } from "../../lib/S3Uploader";
import { createSamplePdf, loadLogo } from "../../lib/pdfService";
import { paginationHelper } from "../../helpers/paginationHelper";
import { query, transaction } from "../../utils/db";
import { logAudit } from "../../utils/audit";
import { buildUpdate } from "../../utils/sqlBuilders";
import assertUuid from "../../utils/assertUuid";
import toKey from "../../utils/toKey";
import { TLanguage, toLanguage } from "../../utils/i18n";
import {
  defaultTemplates,
  templateKeys,
  templateVariables,
  TTemplateKey,
} from "../../utils/email/defaultTemplates";
import { getEffectiveTemplate } from "../../utils/email/templates";
import { IUpdateCompany, TDocType } from "./settings.interface";
import { unknownMergeFields } from "./settings.validation";

const companyColumns = `
  id,
  company_name,
  email,
  phone,
  website,
  street,
  house_number,
  postcode,
  city,
  country,
  kvk_number,
  vat_number,
  iban,
  bic,
  bank_name,
  logo_url,
  default_payment_term_days,
  quote_validity_days,
  quote_followup_days,
  reminder_days_after_due,
  vat_rates,
  number_formats,
  updated_by,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

// column -> optional SQL cast
const companyUpdatableFields: Record<string, string> = {
  company_name: "",
  email: "",
  phone: "",
  website: "",
  street: "",
  house_number: "",
  postcode: "",
  city: "",
  country: "",
  kvk_number: "",
  vat_number: "",
  iban: "",
  bic: "",
  bank_name: "",
  default_payment_term_days: "",
  quote_validity_days: "",
  quote_followup_days: "",
  reminder_days_after_due: "::int[]",
  vat_rates: "::jsonb",
};

// "" -> null so cleared form fields are stored as NULL
const emptyToNull = (value: any) =>
  typeof value === "string"
    ? value.trim() === ""
      ? null
      : value.trim()
    : value;

// The company details used on every document and email
// Inside a transaction pass its client, so the request does not wait for a second pool connection
const getCompanySettings = async (client?: any) => {
  const run = client ? client.query.bind(client) : query;
  const result = await run(
    `SELECT ${companyColumns} FROM company_settings WHERE id = 1`,
  );

  if (result.rows.length === 0) {
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Company settings are missing. Run the database migration.",
    );
  }

  return result.rows[0];
};

const updateCompanySettings = async (
  payload: IUpdateCompany,
  actorId: string,
) => {
  const data: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    data[key] = emptyToNull(value);
  }
  if (typeof data.iban === "string")
    data.iban = data.iban.replace(/\s/g, "").toUpperCase();
  if (typeof data.bic === "string") data.bic = data.bic.toUpperCase();
  if (typeof data.vat_number === "string")
    data.vat_number = data.vat_number.replace(/[\s.]/g, "").toUpperCase();
  if (typeof data.postcode === "string")
    data.postcode = data.postcode.toUpperCase();
  if (typeof data.country === "string")
    data.country = data.country.toUpperCase();
  if (typeof data.email === "string") data.email = data.email.toLowerCase();
  if (data.vat_rates) data.vat_rates = JSON.stringify(data.vat_rates);
  // Merged into the stored formats below, so sending one document type keeps the others
  const numberFormats = data.number_formats
    ? JSON.stringify(data.number_formats)
    : undefined;
  delete data.number_formats;
  if (data.company_name === null) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Company name cannot be empty!");
  }

  const built = buildUpdate(data, companyUpdatableFields);
  const { updates, values } = built;
  let paramCount = built.paramCount;

  if (numberFormats) {
    updates.push(`number_formats = number_formats || $${paramCount++}::jsonb`);
    values.push(numberFormats);
  }

  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }

  updates.push(
    `updated_by = $${paramCount}::uuid`,
    `updated_at = CURRENT_TIMESTAMP`,
  );
  values.push(actorId);

  return transaction(async (client) => {
    const before = (
      await client.query(
        `SELECT ${companyColumns} FROM company_settings WHERE id = 1 FOR UPDATE`,
      )
    ).rows[0];

    const after = (
      await client.query(
        `UPDATE company_settings SET ${updates.join(", ")} WHERE id = 1 RETURNING ${companyColumns}`,
        values,
      )
    ).rows[0];

    // Audit only what changed, with old and new values
    const changes: Record<string, { from: any; to: any }> = {};
    for (const field of [
      ...Object.keys(companyUpdatableFields),
      "number_formats",
    ]) {
      if (
        field === "number_formats" ? !numberFormats : data[field] === undefined
      )
        continue;
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
        changes[field] = { from: before[field], to: after[field] };
      }
    }
    if (Object.keys(changes).length > 0) {
      await logAudit(
        {
          actor_id: actorId,
          action: "UPDATE",
          entity_type: "company_settings",
          entity_id: "1",
          changes,
        },
        client,
      );
    }

    return after;
  });
};

const updateCompanyLogo = async (file: any, actorId: string) => {
  if (!file) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Logo file is required!");
  }
  // pdfkit can only embed PNG and JPEG
  if (!["image/png", "image/jpeg"].includes(file.mimetype)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Logo must be a PNG or JPEG image!",
    );
  }

  let location: string;
  try {
    location = (await S3Uploader.uploadToS3(file, "company/logo")).Location;
  } catch (error) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, "Logo upload failed.");
  }

  const result = await query(
    `UPDATE company_settings
     SET logo_url = $1, updated_by = $2::uuid, updated_at = CURRENT_TIMESTAMP
     WHERE id = 1 RETURNING ${companyColumns}`,
    [location, actorId],
  );
  await logAudit({
    actor_id: actorId,
    action: "UPDATE",
    entity_type: "company_settings",
    entity_id: "1",
    changes: { logo_url: { to: location } },
  });

  return result.rows[0];
};

// ---------------------------------------------------------------------------
// Document numbering (FR-SET-02, FR-INV-04)
// ---------------------------------------------------------------------------

// Next number for a document type, e.g. "2026-0001". Pass the SAME transaction
// `client` that inserts the document: the counter only advances if the document is
// saved, so numbers never have gaps.
const nextDocumentNumber = async (
  docType: TDocType,
  client: any,
  now = new Date(),
) => {
  const settings = await client.query(
    `SELECT number_formats ->> $1 AS format FROM company_settings WHERE id = 1`,
    [docType],
  );
  const format: string | undefined = settings.rows[0]?.format;
  if (!format) {
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      `No number format for ${docType}!`,
    );
  }

  // The counter restarts every year when the format contains the year
  const year = Number(
    new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      timeZone: "Europe/Amsterdam",
    }).format(now),
  );
  const period = /\{YY(YY)?\}/.test(format) ? String(year) : "all";

  // Atomic: the row lock is held until the caller's transaction ends
  const counter = await client.query(
    `INSERT INTO document_sequences (doc_type, period, last_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (doc_type, period)
     DO UPDATE SET last_number = document_sequences.last_number + 1
     RETURNING last_number`,
    [docType, period],
  );
  const number: number = counter.rows[0].last_number;

  return format
    .replace("{YYYY}", String(year))
    .replace("{YY}", String(year).slice(-2))
    .replace(/\{(N+)\}/, (_m, n: string) =>
      String(number).padStart(n.length, "0"),
    );
};

// ---------------------------------------------------------------------------
// Email templates (FR-SET-03)
// ---------------------------------------------------------------------------

const assertTemplateKey = (key: string): TTemplateKey => {
  if (!(templateKeys as readonly string[]).includes(key)) {
    throw new ApiError(httpStatus.NOT_FOUND, "Email template not found!");
  }
  return key as TTemplateKey;
};

const assertLanguage = (language: string): TLanguage => {
  const upper = language.toUpperCase();
  if (upper !== "NL" && upper !== "EN") {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Language should be either NL or EN!",
    );
  }
  return upper;
};

const getEmailTemplates = async () => {
  const customized = await query(
    `SELECT template_key, language FROM email_templates`,
  );
  const custom = new Set(
    customized.rows.map((r) => `${r.template_key}:${r.language}`),
  );

  return templateKeys.flatMap((key) =>
    (["NL", "EN"] as TLanguage[]).map((language) => ({
      template_key: key,
      language,
      subject: defaultTemplates[key][language].subject,
      isCustomized: custom.has(`${key}:${language}`),
      variables: [...templateVariables[key], "company_name"],
    })),
  );
};

const getEmailTemplate = async (keyParam: string, languageParam: string) => {
  const key = assertTemplateKey(keyParam);
  const language = assertLanguage(languageParam);
  const effective = await getEffectiveTemplate(key, language);

  return {
    template_key: key,
    language,
    subject: effective.subject,
    body_html: effective.body_html,
    isCustomized: effective.isCustomized,
    default: defaultTemplates[key][language],
    variables: [...templateVariables[key], "company_name"],
  };
};

const updateEmailTemplate = async (
  keyParam: string,
  languageParam: string,
  payload: { subject: string; body_html: string },
  actorId: string,
) => {
  const key = assertTemplateKey(keyParam);
  const language = assertLanguage(languageParam);

  const unknown = unknownMergeFields(key, payload.subject, payload.body_html);
  if (unknown.length > 0) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Unknown merge fields: ${unknown.map((f) => `{{${f}}}`).join(", ")}. Allowed: ${[
        ...templateVariables[key],
        "company_name",
      ]
        .map((f) => `{{${f}}}`)
        .join(", ")}`,
    );
  }

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO email_templates (template_key, language, subject, body_html, updated_by)
       VALUES ($1, $2::"Language", $3, $4, $5::uuid)
       ON CONFLICT (template_key, language)
       DO UPDATE SET subject = EXCLUDED.subject, body_html = EXCLUDED.body_html,
                     updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
      [key, language, payload.subject, payload.body_html, actorId],
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "email_template",
        entity_id: `${key}:${language}`,
      },
      client,
    );
  });

  return getEmailTemplate(key, language);
};

// Remove the override so the built-in default is used again
const resetEmailTemplate = async (
  keyParam: string,
  languageParam: string,
  actorId: string,
) => {
  const key = assertTemplateKey(keyParam);
  const language = assertLanguage(languageParam);

  await transaction(async (client) => {
    await client.query(
      `DELETE FROM email_templates WHERE template_key = $1 AND language = $2::"Language"`,
      [key, language],
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "DELETE",
        entity_type: "email_template",
        entity_id: `${key}:${language}`,
      },
      client,
    );
  });

  return getEmailTemplate(key, language);
};

// ---------------------------------------------------------------------------
// Audit log and PDF preview
// ---------------------------------------------------------------------------

const getAuditLog = async (params: Record<string, any>) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(params);

  const conditions: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  if (params.entity_type) {
    conditions.push(`a.entity_type = $${paramCount++}`);
    values.push(String(params.entity_type));
  }
  if (params.actor_id) {
    conditions.push(`a.actor_id = $${paramCount++}::uuid`);
    values.push(String(params.actor_id));
  }
  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const [result, count] = await Promise.all([
    query(
      `
        SELECT a.id, a.action, a.entity_type, a.entity_id, a.changes, a.actor_id,
               u.name AS actor_name, a.created_at AS "createdAt"
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.actor_id
        ${whereClause}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      `,
      [...values, limit, skip],
    ),
    query(`SELECT COUNT(*) AS total FROM audit_log a ${whereClause}`, values),
  ]);

  const total = parseInt(count.rows[0].total);
  const totalPage = Math.ceil(total / limit);

  return {
    data: result.rows,
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

// A sample document so the Beheerder can check logo and company details
const previewPdf = async (languageParam?: string) => {
  const language = toLanguage(languageParam);
  const company = await getCompanySettings();
  const logo = await loadLogo(company.logo_url);
  // console.log(company);

  return createSamplePdf(company, language, logo);
};

// ---------------------------------------------------------------------------
// Service types (FR-SET-04)
// ---------------------------------------------------------------------------

const serviceTypeColumns = `
  id, key, label_nl, label_en, sort_order, is_active,
  created_at as "createdAt", updated_at as "updatedAt"
`;

const getServiceTypes = async () => {
  const result = await query(
    `SELECT ${serviceTypeColumns} FROM service_types ORDER BY sort_order ASC, label_en ASC`,
  );
  return result.rows;
};

const createServiceType = async (
  payload: { label_nl: string; label_en: string; sort_order?: number },
  actorId: string,
) => {
  const key = toKey(payload.label_en);
  if (!key) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "The English label needs letters or digits!",
    );
  }

  const existing = await query(`SELECT 1 FROM service_types WHERE key = $1`, [
    key,
  ]);
  if (existing.rows.length > 0) {
    throw new ApiError(
      httpStatus.CONFLICT,
      "A service type with this name already exists!",
    );
  }

  return transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO service_types (key, label_nl, label_en, sort_order)
       VALUES ($1, $2, $3, $4)
       RETURNING ${serviceTypeColumns}`,
      [
        key,
        payload.label_nl.trim(),
        payload.label_en.trim(),
        payload.sort_order ?? 100,
      ],
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "CREATE",
        entity_type: "service_type",
        entity_id: result.rows[0].id,
        changes: { key },
      },
      client,
    );
    return result.rows[0];
  });
};

// Service types are never deleted (quotations and projects keep pointing at
// them); deactivate one to hide it from new inquiries.
const updateServiceType = async (
  id: string,
  payload: {
    label_nl?: string;
    label_en?: string;
    sort_order?: number;
    is_active?: boolean;
  },
  actorId: string,
) => {
  assertUuid(id, "service type id");

  const { updates, values, paramCount } = buildUpdate(
    {
      label_nl: payload.label_nl?.trim(),
      label_en: payload.label_en?.trim(),
      sort_order: payload.sort_order,
      is_active: payload.is_active,
    },
    { label_nl: "", label_en: "", sort_order: "", is_active: "" },
  );

  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }
  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE service_types SET ${updates.join(", ")} WHERE id = $${paramCount}::uuid
       RETURNING ${serviceTypeColumns}`,
      values,
    );
    if (result.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Service type not found!");
    }
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "service_type",
        entity_id: id,
        changes: payload,
      },
      client,
    );
    return result.rows[0];
  });
};

export const SettingsService = {
  getServiceTypes,
  createServiceType,
  updateServiceType,
  getCompanySettings,
  updateCompanySettings,
  updateCompanyLogo,
  nextDocumentNumber,
  getEmailTemplates,
  getEmailTemplate,
  updateEmailTemplate,
  resetEmailTemplate,
  getAuditLog,
  previewPdf,
};
