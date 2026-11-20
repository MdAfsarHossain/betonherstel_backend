import path from "path";
import httpStatus from "http-status";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { loadLogo } from "../../lib/pdfService";
import { S3Uploader } from "../../lib/S3Uploader";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { addDays, amsterdamToday, isValidDay } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { detectFileType } from "../../utils/fileType";
import { formatDate, formatMoney } from "../../utils/formatters";
import { TLanguage, toLanguage } from "../../utils/i18n";
import normalizePostcode from "../../utils/normalizePostcode";
import { resolveServiceTypeId } from "../../utils/serviceTypes";
import { InquiryService } from "../inquiry/inquiry.service";
import { RelationService } from "../relation/relation.service";
import { SettingsService } from "../settings/settings.service";
import {
  calculateLine,
  calculateTotals,
  ICalcLine,
  marginPercent,
  MAX_LINE_CENTS,
  totalsToAmounts,
} from "./quote.calculation";
import {
  IAcceptQuote,
  ICreateQuote,
  IQuoteAddress,
  IQuoteSectionInput,
  ISendQuote,
  IUpdateQuote,
  quoteStatuses,
} from "./quote.interface";
import { buildQuotePdf } from "./quote.pdf";
import { QuoteTemplateService } from "./quote.template.service";
import { fromCents, toCents } from "../../utils/money";
import { notifyAboutQuote } from "../messages/notification.shared";
import { inviteCustomerAfterQuote } from "../portal/portal.autoinvite";

// Offertes (SRS 4.7). A quotation is made for a customer (relation), usually from an
// inquiry, has sections with priced lines, goes out as a branded PDF by email and is
// then accepted or rejected. A sent quotation is locked: changes are made in a new
// revision, and every revision stays viewable (FR-QUO-11).

const MAX_FILES_PER_QUOTE = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const customerTypes = ["PRIVATE", "BUSINESS", "VVE"];

const clean = (value: any) =>
  typeof value === "string"
    ? value.trim() === ""
      ? null
      : value.trim()
    : (value ?? null);

const run = (client?: any) => (client ? client.query.bind(client) : query);

const displayNumber = (q: { number: string; revision: number }) =>
  q.revision > 1 ? `${q.number} (rev. ${q.revision})` : q.number;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Money goes out as numbers (the database returns NUMERIC as text); dates as plain "YYYY-MM-DD"
const quoteListColumns = `
  q.id,
  q.number,
  q.revision,
  q.is_current,
  q.status,
  q.title,
  to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until,
  q.total_incl_vat::float8 AS total_incl_vat,
  q.sent_at,
  q.created_at AS "createdAt",
  (q.status = 'SENT' AND q.is_current AND q.follow_up_reminded_at IS NOT NULL) AS needs_follow_up,
  json_build_object('id', r.id, 'name', r.name, 'type', r.type) AS relation,
  CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object(
    'id', st.id, 'key', st.key, 'label_nl', st.label_nl, 'label_en', st.label_en
  ) END AS service_type,
  CASE WHEN i.id IS NULL THEN NULL ELSE json_build_object(
    'id', i.id, 'reference', i.reference
  ) END AS inquiry
`;

const quoteColumns = `
  q.id,
  q.number,
  q.revision,
  q.is_current,
  q.status,
  q.title,
  q.language,
  q.relation_id,
  q.inquiry_id,
  q.recipient_name,
  q.recipient_email,
  q.street,
  q.house_number,
  q.postcode,
  q.city,
  q.country,
  to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until,
  q.intro_text,
  q.scope_text,
  q.conditions_text,
  q.warranty_text,
  q.internal_notes,
  q.total_excl_vat::float8 AS total_excl_vat,
  q.total_vat::float8 AS total_vat,
  q.total_incl_vat::float8 AS total_incl_vat,
  q.total_cost::float8 AS total_cost,
  q.sent_at,
  q.sent_to,
  (q.pdf_data IS NOT NULL) AS has_pdf,
  q.accepted_at,
  q.accepted_by_name,
  q.accepted_via,
  q.accepted_ip,
  q.terms_accepted,
  q.rejected_at,
  q.reject_reason,
  q.expired_at,
  q.follow_up_reminded_at,
  q.superseded_at,
  q.created_by,
  q.created_at AS "createdAt",
  q.updated_at AS "updatedAt",
  (q.status = 'SENT' AND q.is_current AND q.follow_up_reminded_at IS NOT NULL) AS needs_follow_up,
  (q.status = 'ACCEPTED' AND q.is_current
    AND NOT EXISTS (SELECT 1 FROM projects pr WHERE pr.quote_id = q.id)) AS can_create_project,
  (SELECT json_build_object('id', pr.id, 'number', pr.number)
     FROM projects pr WHERE pr.quote_id = q.id LIMIT 1) AS project,
  json_build_object(
    'id', r.id, 'name', r.name, 'type', r.type, 'email', r.email, 'phone', r.phone,
    'preferred_language', r.preferred_language,
    'billing_street', r.billing_street, 'billing_house_number', r.billing_house_number,
    'billing_postcode', r.billing_postcode, 'billing_city', r.billing_city,
    'billing_country', r.billing_country
  ) AS relation,
  CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object(
    'id', st.id, 'key', st.key, 'label_nl', st.label_nl, 'label_en', st.label_en
  ) END AS service_type,
  CASE WHEN i.id IS NULL THEN NULL ELSE json_build_object(
    'id', i.id, 'reference', i.reference
  ) END AS inquiry
`;

const quoteJoins = `
  JOIN relations r ON r.id = q.relation_id
  LEFT JOIN service_types st ON st.id = q.service_type_id
  LEFT JOIN inquiries i ON i.id = q.inquiry_id
`;

const lineColumns = `
  id, section_id, sort_order, catalogue_item_id, description,
  quantity::float8 AS quantity, unit,
  unit_price::float8 AS unit_price, cost_price::float8 AS cost_price,
  vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge,
  line_total::float8 AS line_total, line_cost::float8 AS line_cost
`;

const attachmentColumns = `
  id, quote_id, file_url, file_name, mime_type, size_bytes, uploaded_by,
  created_at AS "createdAt"
`;

const revisionsOf = async (id: string, client?: any) => {
  const result = await run(client)(
    `
      SELECT id, revision, status, is_current,
             total_incl_vat::float8 AS total_incl_vat,
             to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
             sent_at, created_at AS "createdAt"
      FROM quotes
      WHERE number = (SELECT number FROM quotes WHERE id = $1::uuid)
      ORDER BY revision DESC
    `,
    [id],
  );
  return result.rows;
};

// One quotation with everything: sections and lines (with cost and margin, for the
// office only), attachments, the VAT breakdown and all revisions.
const getQuoteById = async (id: string, client?: any) => {
  assertUuid(id, "quote id");
  const q = run(client);

  const result = await q(
    `SELECT ${quoteColumns} FROM quotes q ${quoteJoins} WHERE q.id = $1::uuid`,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Quotation not found!");
  }

  const [sections, lines, attachments, revisions] = await Promise.all([
    q(
      `SELECT id, title, sort_order FROM quote_sections WHERE quote_id = $1::uuid ORDER BY sort_order ASC`,
      [id],
    ),
    q(
      `SELECT ${lineColumns} FROM quote_lines WHERE quote_id = $1::uuid ORDER BY sort_order ASC`,
      [id],
    ),
    q(
      `SELECT ${attachmentColumns} FROM quote_attachments WHERE quote_id = $1::uuid ORDER BY created_at ASC`,
      [id],
    ),
    revisionsOf(id, client),
  ]);

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const detailedLines = lines.rows.map((l: any) => {
    const margin = round2(l.line_total - l.line_cost);
    return {
      ...l,
      margin,
      margin_percent: marginPercent(toCents(margin), toCents(l.line_total)),
    };
  });

  const calc = calculateTotals(
    lines.rows.map((l: any) => ({
      quantity: l.quantity,
      unit_price: l.unit_price,
      cost_price: l.cost_price,
      vat_code: l.vat_code,
      vat_rate: l.vat_rate,
      vat_reverse_charge: l.vat_reverse_charge,
    })),
  );

  return {
    ...result.rows[0],
    sections: sections.rows.map((s: any) => ({
      ...s,
      lines: detailedLines.filter((l: any) => l.section_id === s.id),
    })),
    attachments: attachments.rows,
    calculation: totalsToAmounts(calc),
    revisions,
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Locks the row so two requests on the same quotation take turns. A single-table
// select: a join would be wrongly re-checked once another request changed the row.
const lockQuote = async (client: any, id: string) => {
  assertUuid(id, "quote id");
  const result = await client.query(
    `
      SELECT id, number, revision, is_current, status, relation_id, inquiry_id,
             to_char(valid_until, 'YYYY-MM-DD') AS valid_until, recipient_email
      FROM quotes WHERE id = $1::uuid FOR UPDATE
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Quotation not found!");
  }
  return result.rows[0];
};

const assertDraft = (quote: { status: string }) => {
  if (quote.status !== "DRAFT") {
    throw new ApiError(
      httpStatus.CONFLICT,
      "Only a draft quotation can be changed. Create a revision to change a sent quotation!",
    );
  }
};

const normalizeAddress = (address: IQuoteAddress) => ({
  street: address.street.trim(),
  house_number: address.house_number.trim(),
  postcode: normalizePostcode(address.postcode),
  city: address.city.trim(),
  country: (address.country ?? "NL").toUpperCase(),
});

// What happened to a quotation, on the customer's timeline
const logQuoteEvent = (
  client: any,
  quote: { id: string; relation_id: string },
  eventType: string,
  title: string,
  actorId: string | null,
  extra: { description?: string | null; metadata?: Record<string, any> } = {},
) =>
  RelationService.logRelationEvent(
    quote.relation_id,
    {
      event_type: eventType,
      entity_type: "quote",
      entity_id: quote.id,
      title,
      description: extra.description ?? null,
      metadata: extra.metadata,
      actor_id: actorId,
    },
    client,
  );

// ---------------------------------------------------------------------------
// Lines and totals (FR-QUO-02, FR-QUO-04, FR-QUO-06)
// ---------------------------------------------------------------------------

interface IPreparedLine extends ICalcLine {
  catalogue_item_id: string | null;
  description: string;
  unit: string;
}

interface IPreparedSection {
  title: string | null;
  lines: IPreparedLine[];
}

// Turns the request's sections into lines ready to store: fills gaps from the
// catalogue, fixes the VAT rate to its current value, and checks the amounts.
const prepareSections = async (
  sections: IQuoteSectionInput[],
): Promise<IPreparedSection[]> => {
  const company = await SettingsService.getCompanySettings();
  const vatRates: { code: string; rate: number; reverse_charge: boolean }[] =
    company.vat_rates;
  const defaultVat = (
    vatRates.find((v) => v.code === "21") ??
    vatRates.find((v) => !v.reverse_charge) ??
    vatRates[0]
  ).code;

  const catalogueItemIds = [
    ...new Set(
      sections.flatMap(
        (s) => s.lines.map((l) => l.catalogue_item_id).filter(Boolean) as string[],
      ),
    ),
  ];
  const catalogueItems = new Map<string, any>();
  if (catalogueItemIds.length > 0) {
    const result = await query(
      `SELECT id, name, description, unit, unit_price::float8 AS unit_price,
              cost_price::float8 AS cost_price, vat_code, is_active
       FROM catalogue_items WHERE id = ANY($1::uuid[])`,
      [catalogueItemIds],
    );
    for (const row of result.rows) catalogueItems.set(row.id, row);
  }

  return sections.map((section, si) => ({
    title: clean(section.title),
    lines: section.lines.map((line, li) => {
      const where = `Section ${si + 1}, line ${li + 1}`;

      const catalogueItem = line.catalogue_item_id ? catalogueItems.get(line.catalogue_item_id) : null;
      if (line.catalogue_item_id && !catalogueItem) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${where}: catalogue item not found!`,
        );
      }
      if (catalogueItem && !catalogueItem.is_active) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${where}: the catalogue item is no longer available!`,
        );
      }

      const description =
        clean(line.description) ?? catalogueItem?.description ?? catalogueItem?.name;
      const unit = line.unit ?? catalogueItem?.unit;
      const unitPrice = line.unit_price ?? catalogueItem?.unit_price;
      if (!description || !unit || unitPrice === undefined) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${where}: description, unit and unit price are required!`,
        );
      }

      const vatCode = line.vat_code ?? catalogueItem?.vat_code ?? defaultVat;
      const vat = vatRates.find((v) => v.code === vatCode);
      if (!vat) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${where}: unknown VAT code ${vatCode}!`,
        );
      }

      const prepared: IPreparedLine = {
        catalogue_item_id: line.catalogue_item_id ?? null,
        description,
        unit,
        quantity: line.quantity,
        unit_price: unitPrice,
        cost_price: line.cost_price ?? catalogueItem?.cost_price ?? 0,
        vat_code: vat.code,
        vat_rate: vat.rate,
        vat_reverse_charge: vat.reverse_charge,
      };

      if (Math.abs(calculateLine(prepared).totalCents) > MAX_LINE_CENTS) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${where}: the amount is too large!`,
        );
      }
      return prepared;
    }),
  }));
};

// Replaces all sections and lines of a draft and stores the new totals
const replaceItems = async (
  client: any,
  quoteId: string,
  sections: IPreparedSection[],
) => {
  await client.query(`DELETE FROM quote_sections WHERE quote_id = $1::uuid`, [
    quoteId,
  ]);

  const all: IPreparedLine[] = [];
  let order = 0;
  for (const [si, section] of sections.entries()) {
    const created = await client.query(
      `INSERT INTO quote_sections (quote_id, title, sort_order) VALUES ($1::uuid, $2, $3) RETURNING id`,
      [quoteId, section.title, si],
    );
    const sectionId = created.rows[0].id;

    for (const line of section.lines) {
      const c = calculateLine(line);
      await client.query(
        `
          INSERT INTO quote_lines (
              quote_id, section_id, sort_order, catalogue_item_id, description, quantity, unit,
              unit_price, cost_price, vat_code, vat_rate, vat_reverse_charge, line_total, line_cost
          ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `,
        [
          quoteId,
          sectionId,
          order++,
          line.catalogue_item_id,
          line.description,
          line.quantity,
          line.unit,
          line.unit_price,
          line.cost_price,
          line.vat_code,
          line.vat_rate,
          line.vat_reverse_charge,
          fromCents(c.totalCents),
          fromCents(c.costCents),
        ],
      );
      all.push(line);
    }
  }

  const totals = calculateTotals(all);
  await client.query(
    `
      UPDATE quotes
      SET total_excl_vat = $2, total_vat = $3, total_incl_vat = $4, total_cost = $5,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid
    `,
    [
      quoteId,
      fromCents(totals.subtotalCents),
      fromCents(totals.totalVatCents),
      fromCents(totals.totalCents),
      fromCents(totals.costCents),
    ],
  );
};

// ---------------------------------------------------------------------------
// Creating and editing a draft (FR-QUO-01, FR-QUO-05, FR-REQ-05)
// ---------------------------------------------------------------------------

const createQuote = async (input: ICreateQuote, actorId: string) => {
  // From an inquiry the customer, address, contact and service type are pre-filled (FR-REQ-05)
  let inquiry: any = null;
  if (input.inquiry_id) {
    assertUuid(input.inquiry_id, "inquiry id");
    const found = await query(
      `SELECT id, reference, relation_id, contact_name, contact_email, street, house_number,
              postcode, city, country, service_type_id, language
       FROM inquiries WHERE id = $1::uuid`,
      [input.inquiry_id],
    );
    if (found.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Inquiry not found!");
    }
    inquiry = found.rows[0];
    if (input.relation_id && input.relation_id !== inquiry.relation_id) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "This inquiry belongs to another customer!",
      );
    }
  }

  const relationId = (input.relation_id ?? inquiry.relation_id) as string;
  assertUuid(relationId, "relation id");
  const relationResult = await query(
    `
      SELECT r.id, r.type, r.name, r.email, r.invoice_email, r.preferred_language, r.is_active,
             pc.name AS contact_name, pc.email AS contact_email
      FROM relations r
      LEFT JOIN relation_contacts pc ON pc.relation_id = r.id AND pc.is_primary
      WHERE r.id = $1::uuid
    `,
    [relationId],
  );
  if (relationResult.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Relation not found!");
  }
  const relation = relationResult.rows[0];
  if (!relation.is_active) {
    throw new ApiError(httpStatus.BAD_REQUEST, "This relation is deactivated!");
  }
  if (!customerTypes.includes(relation.type)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "A quotation can only be made for a customer!",
    );
  }

  const company = await SettingsService.getCompanySettings();
  const language: TLanguage =
    input.language ??
    (inquiry
      ? toLanguage(inquiry.language)
      : toLanguage(relation.preferred_language));

  const serviceTypeId =
    input.service_type !== undefined
      ? await resolveServiceTypeId(input.service_type)
      : (inquiry?.service_type_id ?? null);

  const today = amsterdamToday();
  if (input.valid_until && input.valid_until < today) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "The validity date cannot be in the past!",
    );
  }
  const validUntil =
    input.valid_until ?? addDays(today, company.quote_validity_days);

  const address =
    input.address !== undefined
      ? input.address
        ? normalizeAddress(input.address)
        : null
      : inquiry?.street
        ? normalizeAddress({
            street: inquiry.street,
            house_number: inquiry.house_number,
            postcode: inquiry.postcode,
            city: inquiry.city,
            country: inquiry.country,
          })
        : null;

  // Starting texts from the template for this service type and language (FR-QUO-05)
  const templateTexts = await QuoteTemplateService.getStartingTexts(
    serviceTypeId,
    language,
  );
  const text = (field: keyof typeof templateTexts) =>
    (input as any)[field] !== undefined
      ? clean((input as any)[field])
      : templateTexts[field];

  let title = clean(input.title);
  if (!title) {
    let serviceLabel: string | null = null;
    if (serviceTypeId) {
      const st = await query(
        `SELECT label_nl, label_en FROM service_types WHERE id = $1::uuid`,
        [serviceTypeId],
      );
      serviceLabel =
        st.rows[0]?.[language === "EN" ? "label_en" : "label_nl"] ?? null;
    }
    const base = serviceLabel ?? (language === "EN" ? "Quotation" : "Offerte");
    title = `${base} - ${address?.city ?? relation.name}`.slice(0, 255);
  }

  const recipientName =
    clean(input.recipient_name) ??
    inquiry?.contact_name ??
    relation.contact_name ??
    relation.name;
  const recipientEmail =
    clean(input.recipient_email)?.toLowerCase() ??
    inquiry?.contact_email ??
    relation.contact_email ??
    relation.invoice_email ??
    relation.email ??
    null;

  const prepared = input.sections
    ? await prepareSections(input.sections)
    : null;

  const quoteId = await transaction(async (client) => {
    const number = await SettingsService.nextDocumentNumber("quote", client);

    const created = await client.query(
      `
        INSERT INTO quotes (
            number, relation_id, inquiry_id, service_type_id, title, language,
            recipient_name, recipient_email,
            street, house_number, postcode, city, country,
            valid_until, intro_text, scope_text, conditions_text, warranty_text,
            internal_notes, created_by
        ) VALUES (
            $1, $2::uuid, $3::uuid, $4::uuid, $5, $6::"Language",
            $7, $8,
            $9, $10, $11, $12, COALESCE($13, 'NL'),
            $14::date, $15, $16, $17, $18,
            $19, $20::uuid
        )
        RETURNING id
      `,
      [
        number,
        relationId,
        inquiry?.id ?? null,
        serviceTypeId,
        title,
        language,
        recipientName,
        recipientEmail,
        address?.street ?? null,
        address?.house_number ?? null,
        address?.postcode ?? null,
        address?.city ?? null,
        address?.country ?? null,
        validUntil,
        text("intro_text"),
        text("scope_text"),
        text("conditions_text"),
        text("warranty_text"),
        clean(input.internal_notes),
        actorId,
      ],
    );
    const id = created.rows[0].id as string;

    if (prepared) await replaceItems(client, id, prepared);

    await logQuoteEvent(
      client,
      { id, relation_id: relationId },
      "QUOTE_CREATED",
      `Quotation ${number} created`,
      actorId,
      {
        metadata: { inquiry_id: inquiry?.id ?? null },
      },
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "CREATE",
        entity_type: "quote",
        entity_id: id,
        changes: { number },
      },
      client,
    );

    return id;
  });

  return getQuoteById(quoteId);
};

const updateQuote = async (
  id: string,
  payload: IUpdateQuote,
  actorId: string,
) => {
  await transaction(async (client) => {
    const quote = await lockQuote(client, id);
    assertDraft(quote);

    const data: Record<string, any> = {};
    if (payload.title !== undefined) data.title = clean(payload.title);
    if (payload.language !== undefined) data.language = payload.language;
    if (payload.service_type !== undefined)
      data.service_type_id = await resolveServiceTypeId(
        payload.service_type,
        client,
      );
    if (payload.valid_until !== undefined) {
      if (payload.valid_until < amsterdamToday()) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          "The validity date cannot be in the past!",
        );
      }
      data.valid_until = payload.valid_until;
    }
    if (payload.recipient_name !== undefined)
      data.recipient_name = clean(payload.recipient_name);
    if (payload.recipient_email !== undefined)
      data.recipient_email =
        clean(payload.recipient_email)?.toLowerCase() ?? null;
    for (const field of [
      "intro_text",
      "scope_text",
      "conditions_text",
      "warranty_text",
      "internal_notes",
    ] as const) {
      if (payload[field] !== undefined) data[field] = clean(payload[field]);
    }
    if (payload.address !== undefined) {
      const a = payload.address ? normalizeAddress(payload.address) : null;
      data.street = a?.street ?? null;
      data.house_number = a?.house_number ?? null;
      data.postcode = a?.postcode ?? null;
      data.city = a?.city ?? null;
      data.country = a?.country ?? "NL";
    }

    const casts: Record<string, string> = {
      language: '::"Language"',
      service_type_id: "::uuid",
      valid_until: "::date",
    };
    const updates: string[] = [];
    const values: any[] = [];
    let n = 1;
    for (const [field, value] of Object.entries(data)) {
      updates.push(`${field} = $${n++}${casts[field] ?? ""}`);
      values.push(value);
    }
    if (updates.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
    }
    if (data.title === null) {
      throw new ApiError(httpStatus.BAD_REQUEST, "A quotation needs a title!");
    }
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    await client.query(
      `UPDATE quotes SET ${updates.join(", ")} WHERE id = $${n}::uuid`,
      values,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "quote",
        entity_id: id,
        changes: { fields: Object.keys(data) },
      },
      client,
    );
  });

  return getQuoteById(id);
};

// Replace all sections and lines of a draft in one go (what a quotation builder saves)
const setItems = async (
  id: string,
  sections: IQuoteSectionInput[],
  actorId: string,
) => {
  const prepared = await prepareSections(sections);

  await transaction(async (client) => {
    const quote = await lockQuote(client, id);
    assertDraft(quote);
    await replaceItems(client, id, prepared);
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "quote",
        entity_id: id,
        changes: {
          items: prepared.reduce((n, s) => n + s.lines.length, 0),
        } as any,
      },
      client,
    );
  });

  return getQuoteById(id);
};

// ---------------------------------------------------------------------------
// Listing (FR-QUO-09)
// ---------------------------------------------------------------------------

const asList = (value: any): string[] =>
  String(Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const getAllQuotes = async (params: Record<string, any>) => {
  const { page, limit, skip, sortBy, sortOrder } =
    paginationHelper.calculatePagination(params);

  const sortable: Record<string, string> = {
    created_at: "q.created_at",
    number: "q.number",
    total: "q.total_incl_vat",
    valid_until: "q.valid_until",
    status: "q.status",
    title: "LOWER(q.title)",
  };
  const orderColumn = sortable[sortBy] ?? "q.created_at";
  const orderDirection = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  const conditions: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  // Only the current revision of each quotation, unless asked for all of them
  if (String(params.include_revisions) !== "true")
    conditions.push(`q.is_current`);

  if (params.searchTerm) {
    const term = String(
      Array.isArray(params.searchTerm)
        ? params.searchTerm[0]
        : params.searchTerm,
    )
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(
      `(
        q.number ILIKE $${paramCount}
        OR q.title ILIKE $${paramCount}
        OR q.recipient_name ILIKE $${paramCount}
        OR q.city ILIKE $${paramCount}
        OR r.name ILIKE $${paramCount}
        OR i.reference ILIKE $${paramCount}
      )`,
    );
    values.push(`%${term}%`);
    paramCount++;
  }

  if (params.status) {
    const statuses = asList(params.status).map((s) => s.toUpperCase());
    if (
      statuses.some((s) => !(quoteStatuses as readonly string[]).includes(s))
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Invalid status!");
    }
    conditions.push(`q.status::text = ANY($${paramCount++}::text[])`);
    values.push(statuses);
  }

  if (params.relation_id) {
    assertUuid(String(params.relation_id), "relation id");
    conditions.push(`q.relation_id = $${paramCount++}::uuid`);
    values.push(String(params.relation_id));
  }

  if (params.inquiry_id) {
    assertUuid(String(params.inquiry_id), "inquiry id");
    conditions.push(`q.inquiry_id = $${paramCount++}::uuid`);
    values.push(String(params.inquiry_id));
  }

  if (params.service_type) {
    conditions.push(`st.key = ANY($${paramCount++}::text[])`);
    values.push(asList(params.service_type));
  }

  // Sent quotations whose follow-up reminder has fired and that have no answer yet
  if (String(params.follow_up) === "true") {
    conditions.push(
      `q.status = 'SENT' AND q.is_current AND q.follow_up_reminded_at IS NOT NULL`,
    );
  }

  for (const [param, column, operator] of [
    [
      "created_from",
      "(q.created_at AT TIME ZONE 'Europe/Amsterdam')::date",
      ">=",
    ],
    [
      "created_to",
      "(q.created_at AT TIME ZONE 'Europe/Amsterdam')::date",
      "<=",
    ],
    ["valid_from", "q.valid_until", ">="],
    ["valid_to", "q.valid_until", "<="],
  ] as const) {
    if (params[param]) {
      const day = String(params[param]);
      if (!isValidDay(day)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${param} must be a date like 2026-11-30!`,
        );
      }
      conditions.push(`${column} ${operator} $${paramCount++}::date`);
      values.push(day);
    }
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const [result, count] = await Promise.all([
    query(
      `
        SELECT ${quoteListColumns}
        FROM quotes q ${quoteJoins}
        ${whereClause}
        ORDER BY ${orderColumn} ${orderDirection}, q.id ASC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      `,
      [...values, limit, skip],
    ),
    query(
      `SELECT COUNT(*) AS total FROM quotes q ${quoteJoins} ${whereClause}`,
      values,
    ),
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

// ---------------------------------------------------------------------------
// PDF (FR-QUO-08)
// ---------------------------------------------------------------------------

const generatePdf = async (
  quote: any,
  isDraft: boolean,
  logo: Buffer | null,
  company: any,
) => {
  const language = toLanguage(quote.language);
  return buildQuotePdf(
    {
      number: quote.number,
      revision: quote.revision,
      title: quote.title,
      valid_until: quote.valid_until,
      intro_text: quote.intro_text,
      scope_text: quote.scope_text,
      conditions_text: quote.conditions_text,
      warranty_text: quote.warranty_text,
      recipient_name: quote.recipient_name,
      relation: quote.relation,
      street: quote.street,
      house_number: quote.house_number,
      postcode: quote.postcode,
      city: quote.city,
      sections: quote.sections,
      vat: quote.calculation.vat,
      total_excl_vat: quote.calculation.total_excl_vat,
      total_incl_vat: quote.calculation.total_incl_vat,
    },
    company,
    language,
    {
      logo,
      isDraft,
      issueDate: quote.sent_at ? new Date(quote.sent_at) : new Date(),
    },
  );
};

// A sent quotation's PDF is the exact file that was sent (saved at that moment);
// a draft is rendered fresh, marked as a draft.
const getPdf = async (id: string) => {
  assertUuid(id, "quote id");

  const stored = await query(
    `SELECT number, revision, status, pdf_data FROM quotes WHERE id = $1::uuid`,
    [id],
  );
  if (stored.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Quotation not found!");
  }
  const row = stored.rows[0];
  const filename = `${row.number}${row.revision > 1 ? `-rev${row.revision}` : ""}.pdf`;

  if (row.status !== "DRAFT" && row.pdf_data) {
    return { buffer: row.pdf_data as Buffer, filename };
  }

  const quote = await getQuoteById(id);
  const company = await SettingsService.getCompanySettings();
  const logo = await loadLogo(company.logo_url);
  return {
    buffer: await generatePdf(quote, quote.status === "DRAFT", logo, company),
    filename,
  };
};

// ---------------------------------------------------------------------------
// Sending, accepting, rejecting (FR-QUO-08, FR-QUO-09, FR-QUO-10)
// ---------------------------------------------------------------------------

const sendQuote = async (id: string, input: ISendQuote, actorId: string) => {
  assertUuid(id, "quote id");
  const sendEmailFlag = input.send_email !== false;

  // Company details and logo are fetched before the transaction starts (a network call)
  const company = await SettingsService.getCompanySettings();
  const logo = await loadLogo(company.logo_url);
  const issuedAt = new Date();

  // Step 1: check, lock, render the PDF and mark the quotation as sent. The PDF is
  // saved with it, so what the customer received can always be shown again.
  const prepared = await transaction(async (client) => {
    const row = await lockQuote(client, id);
    assertDraft(row);

    const lineCount = await client.query(
      `SELECT COUNT(*)::int AS n FROM quote_lines WHERE quote_id = $1::uuid`,
      [id],
    );
    if (lineCount.rows[0].n === 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Add at least one line before sending the quotation!",
      );
    }
    if (row.valid_until < amsterdamToday()) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "The validity date has passed. Set a new validity date first!",
      );
    }

    const quote = await getQuoteById(id, client);
    const email =
      clean(input.email)?.toLowerCase() ?? quote.recipient_email ?? null;
    if (sendEmailFlag && !email) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "There is no email address to send the quotation to!",
      );
    }

    const pdf = await generatePdf(
      { ...quote, sent_at: issuedAt.toISOString() },
      false,
      logo,
      company,
    );

    await client.query(
      `
        UPDATE quotes
        SET status = 'SENT', sent_at = $2::timestamptz, sent_to = $3, recipient_email = COALESCE($3, recipient_email),
            pdf_data = $4, follow_up_reminded_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [id, issuedAt.toISOString(), sendEmailFlag ? email : null, pdf],
    );

    return { quote, email, pdf };
  });

  // Step 2: the email. If it cannot be sent the quotation goes back to a draft, so
  // it never says "sent" for something the customer did not receive.
  if (sendEmailFlag) {
    const { quote, email, pdf } = prepared;
    const language = toLanguage(quote.language);
    try {
      await sendTemplatedEmail({
        to: email as string,
        templateKey: "quote",
        language,
        variables: {
          name: quote.recipient_name ?? quote.relation.name,
          quote_number: displayNumber(quote),
          title: quote.title,
          total: formatMoney(quote.total_incl_vat, language),
          valid_until: formatDate(`${quote.valid_until}T12:00:00Z`, language),
          link: `${config.frontend_url}/portal/quotes/${id}`,
        },
        attachments: [
          {
            filename: `${quote.number}.pdf`,
            content: pdf,
            contentType: "application/pdf",
          },
        ],
        related: { type: "quote", id },
        sentBy: actorId,
      });
    } catch (error) {
      await query(
        `
          UPDATE quotes
          SET status = 'DRAFT', sent_at = NULL, sent_to = NULL, pdf_data = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1::uuid AND status = 'SENT' AND sent_at = $2::timestamptz
        `,
        [id, issuedAt.toISOString()],
      );
      throw error;
    }
  }

  // Step 3: the rest of the world learns about it
  await transaction(async (client) => {
    const { quote } = prepared;
    if (quote.inquiry_id) {
      await InquiryService.moveStatusFromQuote(
        client,
        quote.inquiry_id,
        "offerte_verstuurd",
        actorId,
      );
    }
    await logQuoteEvent(
      client,
      quote,
      "QUOTE_SENT",
      `Quotation ${displayNumber(quote)} sent`,
      actorId,
      {
        metadata: {
          emailed: sendEmailFlag,
          to: sendEmailFlag ? prepared.email : null,
        },
      },
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "SEND",
        entity_type: "quote",
        entity_id: id,
        changes: { number: quote.number },
      },
      client,
    );
  });

  // Step 4: the customer's first quotation also brings the invitation to the portal (when they have no
  // account yet). It never fails the sending: the result only says what happened.
  const portalInvitation = sendEmailFlag
    ? await inviteCustomerAfterQuote({
        relationId: prepared.quote.relation_id,
        name: prepared.quote.recipient_name ?? null,
        email: prepared.email,
        language: toLanguage(prepared.quote.language),
        actorId,
        optOut: (input.invite_to_portal as unknown) === false || (input.invite_to_portal as unknown) === "false",
      })
    : ({ invited: false, reason: "NO_EMAIL" } as const);

  return { ...(await getQuoteById(id)), portal_invitation: portalInvitation };
};

// Records that the customer accepted. Called by office staff now, and by the
// customer portal later (via "PORTAL", with the customer's IP address, FR-PORT-04).
const acceptQuote = async (
  id: string,
  input: IAcceptQuote,
  actorId: string | null,
) => {
  if (input.terms_accepted !== true) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "The customer must have agreed to the terms and conditions!",
    );
  }

  await transaction(async (client) => {
    const quote = await lockQuote(client, id);

    if (!quote.is_current) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "This is an older revision. Only the current revision can be accepted!",
      );
    }
    if (quote.status !== "SENT") {
      throw new ApiError(
        httpStatus.CONFLICT,
        quote.status === "DRAFT"
          ? "Send the quotation before it can be accepted!"
          : `This quotation is already ${quote.status.toLowerCase()}!`,
      );
    }
    if (quote.valid_until < amsterdamToday()) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "This quotation has expired. Create a revision with a new validity date!",
      );
    }

    await client.query(
      `
        UPDATE quotes
        SET status = 'ACCEPTED', accepted_at = CURRENT_TIMESTAMP, accepted_by_name = $2,
            accepted_via = $3, accepted_ip = $4, terms_accepted = true, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [id, input.accepted_by_name.trim(), input.via, input.ip ?? null],
    );

    if (quote.inquiry_id) {
      await InquiryService.moveStatusFromQuote(
        client,
        quote.inquiry_id,
        "gewonnen",
        actorId,
      );
    }
    await logQuoteEvent(
      client,
      quote,
      "QUOTE_ACCEPTED",
      `Quotation ${displayNumber(quote)} accepted`,
      actorId,
      {
        description: `${input.accepted_by_name.trim()} (${input.via})`,
        metadata: { via: input.via },
      },
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "ACCEPT",
        entity_type: "quote",
        entity_id: id,
        changes: { via: input.via, by: input.accepted_by_name } as any,
      },
      client,
    );
  });

  await notifyAboutQuote(id, "ACCEPTED", actorId, `${input.accepted_by_name.trim()} (${input.via})`);
  return getQuoteById(id);
};

const rejectQuote = async (
  id: string,
  reason: string | undefined,
  actorId: string | null,
) => {
  await transaction(async (client) => {
    const quote = await lockQuote(client, id);

    if (!quote.is_current) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "This is an older revision. Only the current revision can be rejected!",
      );
    }
    if (quote.status !== "SENT") {
      throw new ApiError(
        httpStatus.CONFLICT,
        quote.status === "DRAFT"
          ? "Send the quotation before it can be rejected!"
          : `This quotation is already ${quote.status.toLowerCase()}!`,
      );
    }

    await client.query(
      `
        UPDATE quotes
        SET status = 'REJECTED', rejected_at = CURRENT_TIMESTAMP, reject_reason = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [id, clean(reason)],
    );
    await logQuoteEvent(
      client,
      quote,
      "QUOTE_REJECTED",
      `Quotation ${displayNumber(quote)} rejected`,
      actorId,
      {
        description: clean(reason),
      },
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "REJECT",
        entity_type: "quote",
        entity_id: id,
        changes: {},
      },
      client,
    );
  });

  await notifyAboutQuote(id, "REJECTED", actorId, clean(reason));
  return getQuoteById(id);
};

// ---------------------------------------------------------------------------
// Revisions (FR-QUO-11)
// ---------------------------------------------------------------------------

// A new draft revision of a sent, rejected or expired quotation. The old revision
// stays viewable and stops being the current one.
const reviseQuote = async (id: string, actorId: string) => {
  const company = await SettingsService.getCompanySettings();

  const newId = await transaction(async (client) => {
    const old = await lockQuote(client, id);

    if (!old.is_current) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "Only the current revision can be revised!",
      );
    }
    if (old.status === "DRAFT") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "A draft can be edited directly!",
      );
    }
    if (old.status === "ACCEPTED") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "An accepted quotation cannot be revised. Record additional work (meerwerk) instead!",
      );
    }

    const latest = await client.query(
      `SELECT MAX(revision) AS revision FROM quotes WHERE number = $1`,
      [old.number],
    );

    // The old one first: only one revision per number may be current
    await client.query(
      `UPDATE quotes SET is_current = false, superseded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id],
    );

    const created = await client.query(
      `
        INSERT INTO quotes (
            number, revision, is_current, relation_id, inquiry_id, service_type_id, title, language,
            status, recipient_name, recipient_email, street, house_number, postcode, city, country,
            valid_until, intro_text, scope_text, conditions_text, warranty_text, internal_notes,
            total_excl_vat, total_vat, total_incl_vat, total_cost, created_by
        )
        SELECT number, $2, true, relation_id, inquiry_id, service_type_id, title, language,
               'DRAFT', recipient_name, recipient_email, street, house_number, postcode, city, country,
               ((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Amsterdam')::date + $3::int),
               intro_text, scope_text, conditions_text, warranty_text, internal_notes,
               total_excl_vat, total_vat, total_incl_vat, total_cost, $4::uuid
        FROM quotes WHERE id = $1::uuid
        RETURNING id
      `,
      [id, latest.rows[0].revision + 1, company.quote_validity_days, actorId],
    );
    const copyId = created.rows[0].id as string;

    // Sections and lines are copied; each section's lines follow it
    const sections = await client.query(
      `SELECT id, title, sort_order FROM quote_sections WHERE quote_id = $1::uuid ORDER BY sort_order`,
      [id],
    );
    for (const section of sections.rows) {
      const copy = await client.query(
        `INSERT INTO quote_sections (quote_id, title, sort_order) VALUES ($1::uuid, $2, $3) RETURNING id`,
        [copyId, section.title, section.sort_order],
      );
      await client.query(
        `
          INSERT INTO quote_lines (
              quote_id, section_id, sort_order, catalogue_item_id, description, quantity, unit, unit_price,
              cost_price, vat_code, vat_rate, vat_reverse_charge, line_total, line_cost
          )
          SELECT $1::uuid, $2::uuid, sort_order, catalogue_item_id, description, quantity, unit, unit_price,
                 cost_price, vat_code, vat_rate, vat_reverse_charge, line_total, line_cost
          FROM quote_lines WHERE section_id = $3::uuid
        `,
        [copyId, copy.rows[0].id, section.id],
      );
    }

    // Attachments point at the same stored files
    await client.query(
      `
        INSERT INTO quote_attachments (quote_id, file_url, storage_key, file_name, mime_type, size_bytes, uploaded_by)
        SELECT $1::uuid, file_url, storage_key, file_name, mime_type, size_bytes, uploaded_by
        FROM quote_attachments WHERE quote_id = $2::uuid
      `,
      [copyId, id],
    );

    await logQuoteEvent(
      client,
      { id: copyId, relation_id: old.relation_id },
      "QUOTE_REVISED",
      `Quotation ${old.number}: revision ${latest.rows[0].revision + 1} created`,
      actorId,
      { metadata: { from_revision: old.revision } },
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "REVISE",
        entity_type: "quote",
        entity_id: copyId,
        changes: { number: old.number, from_revision: old.revision } as any,
      },
      client,
    );

    return copyId;
  });

  return getQuoteById(newId);
};

// ---------------------------------------------------------------------------
// Deleting a draft
// ---------------------------------------------------------------------------

// Only a draft can be deleted. Deleting a draft revision makes the previous
// revision the current one again.
const deleteQuote = async (id: string, actorId: string) => {
  const orphaned: string[] = [];

  await transaction(async (client) => {
    const quote = await lockQuote(client, id);
    if (quote.status !== "DRAFT") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "Only a draft quotation can be deleted!",
      );
    }

    const keys = await client.query(
      `SELECT storage_key FROM quote_attachments WHERE quote_id = $1::uuid`,
      [id],
    );

    await client.query(`DELETE FROM quotes WHERE id = $1::uuid`, [id]);

    if (quote.revision > 1) {
      await client.query(
        `
          UPDATE quotes SET is_current = true, superseded_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE number = $1 AND revision = (SELECT MAX(revision) FROM quotes WHERE number = $1)
        `,
        [quote.number],
      );
    }

    // Files no other revision still uses can be removed from storage afterwards
    for (const { storage_key } of keys.rows) {
      const used = await client.query(
        `SELECT 1 FROM quote_attachments WHERE storage_key = $1 LIMIT 1`,
        [storage_key],
      );
      if (used.rows.length === 0) orphaned.push(storage_key);
    }

    await logQuoteEvent(
      client,
      quote,
      "QUOTE_DELETED",
      `Draft ${displayNumber(quote)} deleted`,
      actorId,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "DELETE",
        entity_type: "quote",
        entity_id: id,
        changes: { number: quote.number, revision: quote.revision } as any,
      },
      client,
    );
  });

  for (const key of orphaned) {
    try {
      await S3Uploader.deleteFromS3(key);
    } catch (error) {
      console.error("❌ Could not delete file from storage:", key, error);
    }
  }
};

// ---------------------------------------------------------------------------
// Attachments (FR-QUO-07)
// ---------------------------------------------------------------------------

const addAttachments = async (id: string, files: any[], actorId: string) => {
  assertUuid(id, "quote id");
  if (!files || files.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No files uploaded!");
  }

  const existing = await query(
    `
      SELECT q.id, q.status, (SELECT COUNT(*)::int FROM quote_attachments a WHERE a.quote_id = q.id) AS n
      FROM quotes q WHERE q.id = $1::uuid
    `,
    [id],
  );
  if (existing.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Quotation not found!");
  }
  assertDraft(existing.rows[0]);
  if (existing.rows[0].n + files.length > MAX_FILES_PER_QUOTE) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `A quotation can have at most ${MAX_FILES_PER_QUOTE} attachments!`,
    );
  }

  // Check every file before uploading any, so a bad one rejects the whole batch
  const checked = files.map((file) => {
    const name = path
      .basename(String(file.originalname ?? "file"))
      .replace(/[\u0000-\u001f]/g, "")
      .slice(0, 255);
    if (!file.buffer || file.buffer.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${name}: the file is empty!`);
    }
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${name}: the file is larger than 10 MB!`,
      );
    }
    const type = detectFileType(file.buffer);
    if (!type) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${name}: only JPEG, PNG, WebP and PDF files are allowed!`,
      );
    }
    return { file, name, mime: type.mime };
  });

  const saved: any[] = [];
  for (const { file, name, mime } of checked) {
    let uploaded: { Location: string; Key: string };
    try {
      uploaded = await S3Uploader.uploadToS3(file, `quotes/${id}`);
    } catch (error) {
      throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, "File upload failed.");
    }

    const result = await query(
      `
        INSERT INTO quote_attachments (quote_id, file_url, storage_key, file_name, mime_type, size_bytes, uploaded_by)
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
        RETURNING ${attachmentColumns}
      `,
      [
        id,
        uploaded.Location,
        uploaded.Key,
        name,
        mime,
        file.buffer.length,
        actorId,
      ],
    );
    saved.push(result.rows[0]);
  }

  return saved;
};

const deleteAttachment = async (id: string, attachmentId: string) => {
  assertUuid(attachmentId, "attachment id");
  let orphanedKey: string | null = null;

  await transaction(async (client) => {
    const quote = await lockQuote(client, id);
    assertDraft(quote);

    const result = await client.query(
      `DELETE FROM quote_attachments WHERE id = $1::uuid AND quote_id = $2::uuid RETURNING storage_key`,
      [attachmentId, id],
    );
    if (result.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Attachment not found!");
    }

    // A file another revision still shows stays in storage
    const used = await client.query(
      `SELECT 1 FROM quote_attachments WHERE storage_key = $1 LIMIT 1`,
      [result.rows[0].storage_key],
    );
    if (used.rows.length === 0) orphanedKey = result.rows[0].storage_key;
  });

  if (orphanedKey) {
    try {
      await S3Uploader.deleteFromS3(orphanedKey);
    } catch (error) {
      console.error(
        "❌ Could not delete file from storage:",
        orphanedKey,
        error,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

// Everything that happened to this quotation number, across all its revisions
const getHistory = async (id: string, params: Record<string, any>) => {
  assertUuid(id, "quote id");

  const exists = await query(`SELECT 1 FROM quotes WHERE id = $1::uuid`, [id]);
  if (exists.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Quotation not found!");
  }

  const { page, limit, skip } = paginationHelper.calculatePagination(params);
  const scope = `
    t.entity_type = 'quote' AND t.entity_id IN (
      SELECT id FROM quotes WHERE number = (SELECT number FROM quotes WHERE id = $1::uuid)
    )
  `;

  const [result, count] = await Promise.all([
    query(
      `
        SELECT t.id, t.event_type, t.entity_id, t.title, t.description, t.metadata, t.actor_id,
               u.name AS actor_name, t.created_at AS "createdAt"
        FROM relation_timeline t
        LEFT JOIN users u ON u.id = t.actor_id
        WHERE ${scope}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $2 OFFSET $3
      `,
      [id, limit, skip],
    ),
    query(`SELECT COUNT(*) AS total FROM relation_timeline t WHERE ${scope}`, [
      id,
    ]),
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

export const QuoteService = {
  createQuote,
  updateQuote,
  setItems,
  getAllQuotes,
  getQuoteById,
  getPdf,
  sendQuote,
  acceptQuote,
  rejectQuote,
  reviseQuote,
  deleteQuote,
  addAttachments,
  deleteAttachment,
  getHistory,
  revisionsOf,
  prepareSections,
};
