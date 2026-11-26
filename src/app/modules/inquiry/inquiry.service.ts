import path from "path";
import httpStatus from "http-status";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { S3Uploader } from "../../lib/S3Uploader";
import { query, transaction } from "../../utils/db";
import assertUuid from "../../utils/assertUuid";
import { buildUpdate } from "../../utils/sqlBuilders";
import normalizePostcode from "../../utils/normalizePostcode";
import { detectFileType } from "../../utils/fileType";
import { resolveServiceTypeId } from "../../utils/serviceTypes";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { TLanguage, toLanguage } from "../../utils/i18n";
import { amsterdamToday } from "../../utils/dates";
import { createAutomaticAction } from "../actions/actions.shared";
import { MessageService } from "../messages/message.service";
import { notify, officeUserIds } from "../messages/notification.shared";
import { RelationService } from "../relation/relation.service";
import { SettingsService } from "../settings/settings.service";
import { InquiryStatusService } from "./inquiry.status.service";
import {
  IChangeStatus,
  ICreateInquiry,
  IInquiryAddress,
  inquirySources,
  IUpdateInquiry,
  statusKinds,
  TInquirySource,
} from "./inquiry.interface";

// Aanvragen (SRS 4.4). An inquiry is a request for work. It is always linked to
// a relation, and moves through the configurable pipeline Nieuw -> ... -> Gewonnen/Verloren.
// Quotations (FR-REQ-05) and inspection appointments (FR-REQ-04) are added by the
// Offertes and Planning modules, which read an inquiry and move its status.

const MAX_FILES_PER_INQUIRY = 30;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // FR-FORM-09: 10 MB per file by default

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Pieces shared by the list and the detail columns
const statusJson = `json_build_object(
    'id', s.id, 'key', s.key, 'label_nl', s.label_nl, 'label_en', s.label_en,
    'kind', s.kind, 'color', s.color
  ) AS status`;

const serviceTypeJson = `CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object(
    'id', st.id, 'key', st.key, 'label_nl', st.label_nl, 'label_en', st.label_en
  ) END AS service_type`;

const assignedUserJson = `CASE WHEN au.id IS NULL THEN NULL ELSE json_build_object(
    'id', au.id, 'name', au.name, 'email', au.email, 'avatar', au.avatar
  ) END AS assigned_user`;

const photoCount = `(SELECT COUNT(*)::int FROM inquiry_photos p WHERE p.inquiry_id = i.id) AS photo_count`;

// Main data only: what a list row, a kanban card or a dashboard item shows.
// Everything else is in the detail (GET /inquiries/:id).
const inquiryListColumns = `
  i.id,
  i.reference,
  i.source,
  i.contact_name,
  i.contact_email,
  i.contact_phone,
  i.city,
  i.first_opened_at,
  i.created_at AS "createdAt",
  ${statusJson},
  ${serviceTypeJson},
  json_build_object('id', r.id, 'name', r.name, 'type', r.type) AS relation,
  ${assignedUserJson},
  ${photoCount}
`;

// Full data for one inquiry
const inquiryColumns = `
  i.id,
  i.reference,
  i.relation_id,
  i.source,
  i.external_ref,
  i.contact_name,
  i.contact_email,
  i.contact_phone,
  i.description,
  i.street,
  i.house_number,
  i.postcode,
  i.city,
  i.country,
  i.language,
  i.lost_reason,
  i.assigned_to,
  i.first_opened_at,
  i.closed_at,
  i.created_at AS "createdAt",
  i.updated_at AS "updatedAt",
  ${statusJson},
  ${serviceTypeJson},
  json_build_object(
    'id', r.id, 'name', r.name, 'type', r.type, 'email', r.email,
    'phone', r.phone, 'preferred_language', r.preferred_language
  ) AS relation,
  ${assignedUserJson},
  ${photoCount}
`;

const inquiryJoins = `
  JOIN inquiry_statuses s ON s.id = i.status_id
  JOIN relations r ON r.id = i.relation_id
  LEFT JOIN service_types st ON st.id = i.service_type_id
  LEFT JOIN users au ON au.id = i.assigned_to
`;

const photoColumns = `
  id, inquiry_id, file_url, file_name, mime_type, size_bytes,
  uploaded_by, created_at AS "createdAt"
`;

const clean = (value: any) =>
  typeof value === "string"
    ? value.trim() === ""
      ? null
      : value.trim()
    : (value ?? null);

// One inquiry with its photos. Staff opening it for the first time clears its
// "new" highlight on the dashboard (FR-DASH-02).
const getInquiryById = async (id: string, markOpenedBy?: string) => {
  assertUuid(id, "inquiry id");

  if (markOpenedBy) {
    await query(
      `UPDATE inquiries SET first_opened_at = CURRENT_TIMESTAMP, first_opened_by = $2::uuid
       WHERE id = $1::uuid AND first_opened_at IS NULL`,
      [id, markOpenedBy],
    );
  }

  const result = await query(
    `SELECT ${inquiryColumns} FROM inquiries i ${inquiryJoins} WHERE i.id = $1::uuid`,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Inquiry not found!");
  }

  const [photos, quotes, appointments, comments] = await Promise.all([
    query(
      `SELECT ${photoColumns} FROM inquiry_photos WHERE inquiry_id = $1::uuid ORDER BY created_at ASC`,
      [id],
    ),
    // The quotations made for this inquiry (current revisions only)
    query(
      `
        SELECT id, number, revision, status,
               to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
               total_incl_vat::float8 AS total_incl_vat,
               created_at AS "createdAt"
        FROM quotes WHERE inquiry_id = $1::uuid AND is_current
        ORDER BY created_at DESC
      `,
      [id],
    ),
    // The appointments planned for this inquiry, e.g. its site inspection (cancelled ones left out)
    query(
      `
        SELECT a.id, a.type, a.status, a.title, a.starts_at, a.ends_at, a.all_day,
               COALESCE((
                 SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
                 FROM appointment_assignees aa JOIN users u ON u.id = aa.user_id
                 WHERE aa.appointment_id = a.id
               ), '[]'::json) AS assignees
        FROM appointments a
        WHERE a.inquiry_id = $1::uuid AND a.status <> 'CANCELLED'
        ORDER BY a.starts_at ASC
      `,
      [id],
    ),
    // Office comments of the whole file (this inquiry, its quotations, the project made from them)
    MessageService.getCommentsOfRecord("inquiry", id),
  ]);

  return {
    ...result.rows[0],
    photos: photos.rows,
    quotes: quotes.rows,
    appointments: appointments.rows,
    comments: comments.data,
    comments_total: comments.total,
  };
};

// ---------------------------------------------------------------------------
// Lookups used when creating and editing
// ---------------------------------------------------------------------------

const resolveServiceType = resolveServiceTypeId;

// Responsible person: an active Beheerder or Kantoor user
const assertAssignable = async (userId: string) => {
  assertUuid(userId, "user id");
  const result = await query(
    `SELECT 1 FROM users
     WHERE id = $1::uuid AND is_active AND status = 'ACTIVE' AND role IN ('SUPERADMIN', 'ADMIN', 'OFFICE')`,
    [userId],
  );
  if (result.rows.length === 0) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "An inquiry can only be assigned to an active office user!",
    );
  }
};

// The relation plus its primary contact person, used to fill in missing contact details
const getRelationBrief = async (relationId: string) => {
  assertUuid(relationId, "relation id");
  const result = await query(
    `
        SELECT r.id, r.name, r.email, r.phone, r.preferred_language, r.is_active,
               pc.name AS contact_name, pc.email AS contact_email, pc.phone AS contact_phone
        FROM relations r
        LEFT JOIN relation_contacts pc ON pc.relation_id = r.id AND pc.is_primary
        WHERE r.id = $1::uuid
    `,
    [relationId],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Relation not found!");
  }
  if (!result.rows[0].is_active) {
    throw new ApiError(httpStatus.BAD_REQUEST, "This relation is deactivated!");
  }
  return result.rows[0];
};

const normalizeAddress = (address: IInquiryAddress) => ({
  street: address.street.trim(),
  house_number: address.house_number.trim(),
  postcode: normalizePostcode(address.postcode),
  city: address.city.trim(),
  country: (address.country ?? "NL").toUpperCase(),
});

// ---------------------------------------------------------------------------
// Notifications (FR-REQ-07)
// ---------------------------------------------------------------------------

const sourceLabels: Record<TInquirySource, Record<TLanguage, string>> = {
  FORM: { NL: "Webformulier", EN: "Web form" },
  WEBHOOK: { NL: "Website", EN: "Website" },
  PORTAL: { NL: "Klantportaal", EN: "Customer portal" },
  PHONE: { NL: "Telefoon", EN: "Phone" },
  EMAIL: { NL: "E-mail", EN: "Email" },
  OTHER: { NL: "Overig", EN: "Other" },
};

const serviceLabel = (inquiry: any, language: TLanguage) =>
  inquiry.service_type?.[language === "EN" ? "label_en" : "label_nl"] ??
  (language === "EN" ? "our services" : "onze diensten");

// Confirmation to the customer and a heads-up to the office. A failed email never
// fails the inquiry (the email service logs it); the inquiry is already saved.
const notifyNewInquiry = async (
  inquiry: any,
  actorId: string | null,
  sendConfirmation: boolean,
) => {
  const jobs: Promise<unknown>[] = [];

  if (sendConfirmation && inquiry.contact_email) {
    const language = toLanguage(inquiry.language);
    jobs.push(
      sendTemplatedEmail({
        to: inquiry.contact_email,
        templateKey: "inquiry_confirmation",
        language,
        variables: {
          name: inquiry.contact_name,
          reference: inquiry.reference,
          service: serviceLabel(inquiry, language),
        },
        related: { type: "inquiry", id: inquiry.id },
        sentBy: actorId,
        // Handled at once: a database query follows before allSettled, and an unhandled rejection
        // in between would stop the whole server
      }).catch(() => undefined),
    );
  }

  // Everyone in the office except the person who just entered it themselves
  const staff = await query(
    `SELECT id, email, preferred_language FROM users
     WHERE is_active AND status = 'ACTIVE' AND role IN ('ADMIN', 'OFFICE')
       AND ($1::uuid IS NULL OR id != $1::uuid)`,
    [actorId],
  );

  for (const user of staff.rows) {
    const language = toLanguage(user.preferred_language);
    jobs.push(
      sendTemplatedEmail({
        to: user.email,
        templateKey: "new_inquiry",
        language,
        variables: {
          name: inquiry.relation.name,
          email: inquiry.contact_email ?? "",
          phone: inquiry.contact_phone ?? "",
          reference: inquiry.reference,
          service: serviceLabel(inquiry, language),
          source: sourceLabels[inquiry.source as TInquirySource][language],
          contact: [
            inquiry.contact_name,
            inquiry.contact_email,
            inquiry.contact_phone,
          ]
            .filter(Boolean)
            .join(" · "),
          description: (inquiry.description ?? "").slice(0, 400),
          link: `${config.frontend_url}/inquiries/${inquiry.id}`,
        },
        related: { type: "inquiry", id: inquiry.id },
      }).catch(() => undefined),
    );
  }

  await Promise.allSettled(jobs);
};

// ---------------------------------------------------------------------------
// Creating (FR-REQ-01, FR-REQ-02)
// ---------------------------------------------------------------------------

// The one entry point for every way an inquiry arrives. Office staff call it
// with a manual source; the form builder, the website webhook and the customer
// portal call it with FORM / WEBHOOK / PORTAL and no actor.
//
// Customer matching: with `relation_id` the inquiry is linked to that relation.
// Otherwise public sources are linked to an active relation with the same
// email, and a new relation is created if there is none. Office staff entering a
// new customer get the likely duplicates back first (like the relation module).
const createInquiry = async (input: ICreateInquiry, actorId: string | null) => {
  const isPublic = ["FORM", "WEBHOOK", "PORTAL"].includes(input.source);

  // The same delivery twice (webhook retry, double submit) returns the first inquiry
  if (input.external_ref) {
    const existing = await query(
      `SELECT id FROM inquiries WHERE source = $1::"InquirySource" AND external_ref = $2`,
      [input.source, input.external_ref],
    );
    if (existing.rows.length > 0) {
      return {
        created: false as const,
        reason: "already_received" as const,
        inquiry: await getInquiryById(existing.rows[0].id),
      };
    }
  }

  let contactName: string | null = clean(input.contact_name);
  let contactEmail: string | null =
    clean(input.contact_email)?.toLowerCase() ?? null;
  let contactPhone: string | null = clean(input.contact_phone);
  const address = input.address ? normalizeAddress(input.address) : null;

  const serviceTypeId = await resolveServiceType(input.service_type);
  if (input.assigned_to) await assertAssignable(input.assigned_to);

  let relationId: string | null = input.relation_id ?? null;
  let relationLanguage: TLanguage | null = null;

  if (relationId) {
    const relation = await getRelationBrief(relationId);
    relationLanguage = toLanguage(relation.preferred_language);
    // Missing contact details come from the relation's primary contact
    contactName = contactName ?? relation.contact_name ?? relation.name;
    contactEmail =
      contactEmail ??
      (relation.contact_email ?? relation.email)?.toLowerCase() ??
      null;
    contactPhone =
      contactPhone ?? relation.contact_phone ?? relation.phone ?? null;
  } else if (isPublic) {
    const match = contactEmail
      ? await RelationService.findActiveByEmail(contactEmail)
      : null;
    if (match) {
      relationId = match.id;
      relationLanguage = toLanguage(match.preferred_language);
    }
  } else if (!input.allow_duplicate_relation) {
    const duplicates = await RelationService.findDuplicates({
      email: contactEmail,
      phone: contactPhone,
      billing_postcode: address?.postcode,
      billing_house_number: address?.house_number,
      addresses: address ? [address] : [],
    });
    if (duplicates.length > 0) {
      return {
        created: false as const,
        reason: "duplicates" as const,
        duplicates,
      };
    }
  }

  if (!contactName) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Contact name is required!");
  }
  if (!contactEmail && !contactPhone) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "An email or phone number is required!",
    );
  }

  const language: TLanguage = input.language ?? relationLanguage ?? "NL";

  let inquiryId: string;
  try {
    inquiryId = await transaction(async (client) => {
      // A new customer: a private person, or a company / VvE with this person as contact
      if (!relationId) {
        const type =
          input.relation_type ??
          (clean(input.company_name) ? "BUSINESS" : "PRIVATE");
        relationId = await RelationService.createRelationInTransaction(
          client,
          {
            type,
            name:
              type === "PRIVATE"
                ? contactName!
                : (clean(input.company_name) ?? contactName!),
            email: contactEmail,
            phone: contactPhone,
            preferred_language: language,
            // A private person lives where the work is; for companies billing is entered later
            ...(type === "PRIVATE" && address
              ? {
                  billing_street: address.street,
                  billing_house_number: address.house_number,
                  billing_postcode: address.postcode,
                  billing_city: address.city,
                  billing_country: address.country,
                }
              : {}),
            contacts:
              type === "PRIVATE"
                ? []
                : [
                    {
                      name: contactName!,
                      email: contactEmail,
                      phone: contactPhone,
                      is_primary: true,
                    },
                  ],
            addresses: address ? [address] : [],
          },
          actorId,
        );
      }

      const status = await client.query(
        `SELECT id FROM inquiry_statuses WHERE kind = 'NEW' AND is_active ORDER BY sort_order ASC LIMIT 1`,
      );
      if (status.rows.length === 0) {
        throw new ApiError(
          httpStatus.INTERNAL_SERVER_ERROR,
          "No starting status is configured for inquiries!",
        );
      }

      const reference = await SettingsService.nextDocumentNumber(
        "inquiry",
        client,
      );

      const created = await client.query(
        `
          INSERT INTO inquiries (
              reference, relation_id, status_id, service_type_id, source, external_ref,
              contact_name, contact_email, contact_phone, description,
              street, house_number, postcode, city, country,
              language, assigned_to, created_by
          ) VALUES (
              $1, $2::uuid, $3::uuid, $4::uuid, $5::"InquirySource", $6,
              $7, $8, $9, $10,
              $11, $12, $13, $14, COALESCE($15, 'NL'),
              $16::"Language", $17::uuid, $18::uuid
          )
          RETURNING id
        `,
        [
          reference,
          relationId,
          status.rows[0].id,
          serviceTypeId,
          input.source,
          input.external_ref ?? null,
          contactName,
          contactEmail,
          contactPhone,
          clean(input.description),
          address?.street ?? null,
          address?.house_number ?? null,
          address?.postcode ?? null,
          address?.city ?? null,
          address?.country ?? null,
          language,
          input.assigned_to ?? null,
          actorId,
        ],
      );
      const id = created.rows[0].id as string;

      await RelationService.logRelationEvent(
        relationId,
        {
          event_type: "INQUIRY_CREATED",
          entity_type: "inquiry",
          entity_id: id,
          title: `Inquiry ${reference} received`,
          description: clean(input.description)?.slice(0, 500),
          metadata: { source: input.source },
          actor_id: actorId,
        },
        client,
      );

      return id;
    });
  } catch (error: any) {
    // Two deliveries of the same inquiry arrived at the same moment
    if (error?.code === "23505" && input.external_ref) {
      const existing = await query(
        `SELECT id FROM inquiries WHERE source = $1::"InquirySource" AND external_ref = $2`,
        [input.source, input.external_ref],
      );
      if (existing.rows.length > 0) {
        return {
          created: false as const,
          reason: "already_received" as const,
          inquiry: await getInquiryById(existing.rows[0].id),
        };
      }
    }
    throw error;
  }

  const inquiry = await getInquiryById(inquiryId);
  await notifyNewInquiry(inquiry, actorId, input.send_confirmation !== false);

  // The office sees it in their notifications until someone opens it (FR-DASH-02)
  await notify(await officeUserIds(), {
    type: "NEW_INQUIRY",
    title: `New inquiry ${inquiry.reference} from ${inquiry.relation?.name ?? inquiry.contact_name}`,
    body: inquiry.description,
    entity: { type: "inquiry", id: inquiry.id },
    actorId,
  });

  // A task for the office to pick the inquiry up (FR-MSG-04): for the person it is assigned to,
  // otherwise for the team
  await createAutomaticAction({
    auto_type: "new_inquiry",
    auto_key: `new_inquiry:${inquiry.id}`,
    title: `Handle new inquiry ${inquiry.reference}`,
    description: [
      inquiry.relation?.name,
      inquiry.contact_phone ?? inquiry.contact_email,
      (inquiry.description ?? "").slice(0, 200),
    ]
      .filter(Boolean)
      .join(" · "),
    due_date: amsterdamToday(),
    assignee_id: input.assigned_to ?? null,
    entity: { type: "inquiry", id: inquiry.id },
  });

  return { created: true as const, inquiry };
};

// ---------------------------------------------------------------------------
// Listing: list view, pipeline (kanban) view, dashboard summary (FR-REQ-06)
// ---------------------------------------------------------------------------

const asList = (value: any): string[] =>
  String(Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

// Builds the WHERE clause shared by the list and the pipeline
const buildFilter = (
  params: Record<string, any>,
  actorId: string,
  options: { ignoreStatus?: boolean } = {},
) => {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  if (params.searchTerm) {
    // Escape LIKE wildcards so a search for "50%" is literal
    const term = String(
      Array.isArray(params.searchTerm)
        ? params.searchTerm[0]
        : params.searchTerm,
    )
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(
      `(
        i.reference ILIKE $${paramCount}
        OR i.contact_name ILIKE $${paramCount}
        OR i.contact_email ILIKE $${paramCount}
        OR i.contact_phone ILIKE $${paramCount}
        OR i.description ILIKE $${paramCount}
        OR i.city ILIKE $${paramCount}
        OR i.postcode ILIKE $${paramCount}
        OR r.name ILIKE $${paramCount}
      )`,
    );
    values.push(`%${term}%`);
    paramCount++;
  }

  if (!options.ignoreStatus) {
    if (params.status) {
      conditions.push(`s.key = ANY($${paramCount++}::text[])`);
      values.push(asList(params.status));
    }
    if (params.kind) {
      const kinds = asList(params.kind).map((k) => k.toUpperCase());
      if (kinds.some((k) => !(statusKinds as readonly string[]).includes(k))) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Invalid status kind!");
      }
      conditions.push(`s.kind = ANY($${paramCount++}::text[])`);
      values.push(kinds);
    }
  }

  if (params.source) {
    const sources = asList(params.source).map((s) => s.toUpperCase());
    if (
      sources.some((s) => !(inquirySources as readonly string[]).includes(s))
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Invalid source!");
    }
    conditions.push(`i.source::text = ANY($${paramCount++}::text[])`);
    values.push(sources);
  }

  if (params.service_type) {
    conditions.push(`st.key = ANY($${paramCount++}::text[])`);
    values.push(asList(params.service_type));
  }

  if (params.relation_id) {
    assertUuid(String(params.relation_id), "relation id");
    conditions.push(`i.relation_id = $${paramCount++}::uuid`);
    values.push(String(params.relation_id));
  }

  if (params.assigned_to) {
    const who = String(params.assigned_to);
    if (who === "none") {
      conditions.push(`i.assigned_to IS NULL`);
    } else {
      const id = who === "me" ? actorId : who;
      assertUuid(id, "user id");
      conditions.push(`i.assigned_to = $${paramCount++}::uuid`);
      values.push(id);
    }
  }

  if (String(params.unopened) === "true") {
    conditions.push(`i.first_opened_at IS NULL`);
  }

  // Calendar days in the Netherlands, so "today" matches what the office sees
  for (const [param, operator] of [
    ["created_from", ">="],
    ["created_to", "<="],
  ] as const) {
    if (params[param]) {
      const day = String(params[param]);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        Number.isNaN(new Date(day).getTime())
      ) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${param} must be a date like 2026-11-30!`,
        );
      }
      conditions.push(
        `(i.created_at AT TIME ZONE 'Europe/Amsterdam')::date ${operator} $${paramCount++}::date`,
      );
      values.push(day);
    }
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
    paramCount,
  };
};

// List view: search, filter, sort, paginate
const getAllInquiries = async (
  params: Record<string, any>,
  actorId: string,
) => {
  const { page, limit, skip, sortBy, sortOrder } =
    paginationHelper.calculatePagination(params);

  // Sort column / direction go into the SQL text, so only whitelisted values are allowed
  const sortable: Record<string, string> = {
    created_at: "i.created_at",
    updated_at: "i.updated_at",
    reference: "i.reference",
    contact_name: "LOWER(i.contact_name)",
    status: "s.sort_order",
  };
  const orderColumn = sortable[sortBy] ?? "i.created_at";
  const orderDirection = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  const { whereClause, values, paramCount } = buildFilter(params, actorId);

  const [result, countResult] = await Promise.all([
    query(
      `
        SELECT ${inquiryListColumns}
        FROM inquiries i ${inquiryJoins}
        ${whereClause}
        ORDER BY ${orderColumn} ${orderDirection}, i.id ASC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      `,
      [...values, limit, skip],
    ),
    query(
      `SELECT COUNT(*) AS total FROM inquiries i ${inquiryJoins} ${whereClause}`,
      values,
    ),
  ]);

  const total = parseInt(countResult.rows[0].total);
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

// Pipeline (kanban) view: one column per active status with its newest inquiries
// and the full count. A column's remaining cards come from the list endpoint
// filtered on that status.
const getPipeline = async (params: Record<string, any>, actorId: string) => {
  const perColumn = Math.min(
    Math.max(Number(params.limit_per_status) || 25, 1),
    100,
  );
  const { whereClause, values, paramCount } = buildFilter(params, actorId, {
    ignoreStatus: true,
  });

  const [statuses, cards, counts] = await Promise.all([
    InquiryStatusService.getStatuses(true),
    query(
      `
        WITH ranked AS (
          SELECT ${inquiryListColumns},
                 i.status_id AS column_status_id,
                 ROW_NUMBER() OVER (PARTITION BY i.status_id ORDER BY i.created_at DESC, i.id DESC) AS rn
          FROM inquiries i ${inquiryJoins}
          ${whereClause}
        )
        SELECT * FROM ranked WHERE rn <= $${paramCount} ORDER BY "createdAt" DESC, id ASC
      `,
      [...values, perColumn],
    ),
    query(
      `SELECT i.status_id, COUNT(*)::int AS total FROM inquiries i ${inquiryJoins} ${whereClause} GROUP BY i.status_id`,
      values,
    ),
  ]);

  const totals = new Map<string, number>(
    counts.rows.map((r) => [r.status_id, r.total]),
  );
  const includeClosed = String(params.include_closed) !== "false";

  const columns = statuses
    .filter((s) => includeClosed || (s.kind !== "WON" && s.kind !== "LOST"))
    .map((s) => {
      const items = cards.rows
        .filter((c) => c.column_status_id === s.id)
        .map(({ column_status_id, rn, ...card }) => card);
      return {
        status: {
          id: s.id,
          key: s.key,
          label_nl: s.label_nl,
          label_en: s.label_en,
          kind: s.kind,
          color: s.color,
          sort_order: s.sort_order,
        },
        total: totals.get(s.id) ?? 0,
        items,
      };
    });

  return { columns };
};

// Dashboard tile (FR-DASH-01) and the "new inquiries" highlight (FR-DASH-02)
const getSummary = async () => {
  const [byStatus, unopened, latest] = await Promise.all([
    query(
      `
        SELECT s.id, s.key, s.label_nl, s.label_en, s.kind, s.color, s.sort_order,
               COUNT(i.id)::int AS count
        FROM inquiry_statuses s
        LEFT JOIN inquiries i ON i.status_id = s.id
        GROUP BY s.id
        HAVING s.is_active OR COUNT(i.id) > 0
        ORDER BY s.sort_order ASC
      `,
    ),
    query(
      `SELECT COUNT(*)::int AS count FROM inquiries WHERE first_opened_at IS NULL`,
    ),
    query(
      `
        SELECT ${inquiryListColumns}
        FROM inquiries i ${inquiryJoins}
        WHERE i.first_opened_at IS NULL
        ORDER BY i.created_at DESC, i.id ASC
        LIMIT 10
      `,
    ),
  ]);

  const byKind: Record<string, number> = { NEW: 0, OPEN: 0, WON: 0, LOST: 0 };
  let total = 0;
  for (const row of byStatus.rows) {
    byKind[row.kind] += row.count;
    total += row.count;
  }

  return {
    total,
    open: byKind.NEW + byKind.OPEN,
    unopened: unopened.rows[0].count,
    by_kind: byKind,
    by_status: byStatus.rows,
    latest_unopened: latest.rows,
  };
};

// Lists for filters and forms
const getOptions = async () => {
  const [statuses, serviceTypes] = await Promise.all([
    InquiryStatusService.getStatuses(true),
    query(
      `SELECT id, key, label_nl, label_en FROM service_types WHERE is_active ORDER BY sort_order ASC, label_en ASC`,
    ),
  ]);

  return {
    statuses: statuses.map((s) => ({
      id: s.id,
      key: s.key,
      label_nl: s.label_nl,
      label_en: s.label_en,
      kind: s.kind,
      color: s.color,
      sort_order: s.sort_order,
    })),
    service_types: serviceTypes.rows,
    sources: [...inquirySources],
    manual_sources: ["PHONE", "EMAIL", "OTHER"],
  };
};

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

const updateInquiry = async (id: string, payload: IUpdateInquiry) => {
  assertUuid(id, "inquiry id");

  const existingResult = await query(
    `SELECT id, contact_email, contact_phone FROM inquiries WHERE id = $1::uuid`,
    [id],
  );
  if (existingResult.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Inquiry not found!");
  }
  const existing = existingResult.rows[0];

  const data: Record<string, any> = {};

  if (payload.service_type !== undefined) {
    data.service_type_id = await resolveServiceType(payload.service_type);
  }
  if (payload.description !== undefined)
    data.description = clean(payload.description);
  if (payload.contact_name !== undefined)
    data.contact_name = clean(payload.contact_name);
  if (payload.contact_email !== undefined) {
    data.contact_email = clean(payload.contact_email)?.toLowerCase() ?? null;
  }
  if (payload.contact_phone !== undefined)
    data.contact_phone = clean(payload.contact_phone);
  if (payload.language !== undefined) data.language = payload.language;
  if (payload.assigned_to !== undefined) {
    if (payload.assigned_to) await assertAssignable(payload.assigned_to);
    data.assigned_to = payload.assigned_to ?? null;
  }
  if (payload.relation_id !== undefined) {
    await getRelationBrief(payload.relation_id);
    data.relation_id = payload.relation_id;
  }
  if (payload.address !== undefined) {
    const a = payload.address ? normalizeAddress(payload.address) : null;
    data.street = a?.street ?? null;
    data.house_number = a?.house_number ?? null;
    data.postcode = a?.postcode ?? null;
    data.city = a?.city ?? null;
    data.country = a?.country ?? "NL";
  }

  // Still reachable after the change
  const email =
    data.contact_email !== undefined
      ? data.contact_email
      : existing.contact_email;
  const phone =
    data.contact_phone !== undefined
      ? data.contact_phone
      : existing.contact_phone;
  if (!email && !phone) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "An email or phone number is required!",
    );
  }

  const { updates, values, paramCount } = buildUpdate(data, {
    service_type_id: "::uuid",
    description: "",
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    language: '::"Language"',
    assigned_to: "::uuid",
    relation_id: "::uuid",
    street: "",
    house_number: "",
    postcode: "",
    city: "",
    country: "",
  });

  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }
  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  await transaction(async (client) => {
    await client.query(
      `UPDATE inquiries SET ${updates.join(", ")} WHERE id = $${paramCount}::uuid`,
      values,
    );

    // Linked to another customer: its history (created, status changes, notes)
    // moves to that customer's timeline too, so neither timeline is misleading
    if (data.relation_id !== undefined) {
      await client.query(
        `UPDATE relation_timeline SET relation_id = $1::uuid
         WHERE entity_type = 'inquiry' AND entity_id = $2::uuid`,
        [data.relation_id, id],
      );
    }
  });

  return getInquiryById(id);
};

// Move an inquiry to another status: a drag in the kanban view, or the status
// dropdown. Moving to a "lost" status needs a reason (FR-REQ-08).
// Moves an inquiry to another status inside the caller's transaction. Shared by
// the manual status change (strict: wrong input is an error) and by other modules
// that move an inquiry as a side effect (silent: if the move does not apply, do
// nothing). Returns true when the status changed.
const applyStatusChange = async (
  client: any,
  id: string,
  targetKey: string,
  options: {
    lostReason?: string | null;
    actorId: string | null;
    silent?: boolean;
    // Silent moves only happen from these kinds of status (e.g. never reopen a lost inquiry)
    onlyFromKinds?: string[];
    // Silent moves only go forward in the pipeline (to a later status), never back
    onlyForward?: boolean;
  },
): Promise<boolean> => {
  const silent = options.silent === true;
  const fail = (status: number, message: string) => {
    if (silent) return false;
    throw new ApiError(status, message);
  };

  // Lock the row on its own (no join): when two requests race, the second one
  // waits here and then sees the status the first one set. With a join, Postgres
  // re-checks the join against the old status row and wrongly finds nothing.
  const locked = await client.query(
    `SELECT id, reference, relation_id, status_id FROM inquiries WHERE id = $1::uuid FOR UPDATE`,
    [id],
  );
  if (locked.rows.length === 0) {
    return fail(httpStatus.NOT_FOUND, "Inquiry not found!");
  }
  const currentStatus = await client.query(
    `SELECT key, label_en, kind, sort_order FROM inquiry_statuses WHERE id = $1::uuid`,
    [locked.rows[0].status_id],
  );
  const inquiry = {
    ...locked.rows[0],
    status_key: currentStatus.rows[0].key,
    status_label: currentStatus.rows[0].label_en,
    status_kind: currentStatus.rows[0].kind,
  };

  const target = await client.query(
    `SELECT id, key, label_en, kind, sort_order, is_active FROM inquiry_statuses WHERE key = $1`,
    [targetKey],
  );
  if (target.rows.length === 0 || !target.rows[0].is_active) {
    return fail(httpStatus.BAD_REQUEST, "Unknown status!");
  }
  const status = target.rows[0];

  if (status.key === inquiry.status_key) {
    return fail(httpStatus.BAD_REQUEST, "The inquiry already has this status!");
  }
  if (
    options.onlyFromKinds &&
    !options.onlyFromKinds.includes(inquiry.status_kind)
  ) {
    return false;
  }
  if (
    options.onlyForward &&
    status.sort_order <= currentStatus.rows[0].sort_order
  ) {
    return false;
  }

  const lostReason = clean(options.lostReason);
  if (status.kind === "LOST" && (!lostReason || lostReason.length < 3)) {
    return fail(httpStatus.BAD_REQUEST, "A lost reason is required!");
  }

  // A reason only belongs to a lost inquiry; closing sets the time, reopening clears it
  await client.query(
    `
        UPDATE inquiries
        SET status_id = $2::uuid,
            lost_reason = $3,
            closed_at = CASE WHEN $4 IN ('WON', 'LOST') THEN CURRENT_TIMESTAMP ELSE NULL END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
    [id, status.id, status.kind === "LOST" ? lostReason : null, status.kind],
  );

  await RelationService.logRelationEvent(
    inquiry.relation_id,
    {
      event_type: "INQUIRY_STATUS_CHANGED",
      entity_type: "inquiry",
      entity_id: id,
      title: `Inquiry ${inquiry.reference}: ${inquiry.status_label} → ${status.label_en}`,
      description: status.kind === "LOST" ? lostReason : null,
      metadata: { from: inquiry.status_key, to: status.key },
      actor_id: options.actorId,
    },
    client,
  );

  return true;
};

const changeStatus = async (
  id: string,
  payload: IChangeStatus,
  actorId: string,
) => {
  assertUuid(id, "inquiry id");

  await transaction((client) =>
    applyStatusChange(client, id, payload.status, {
      lostReason: payload.lost_reason,
      actorId,
    }),
  );

  return getInquiryById(id);
};

// Called by the quotation module: a sent quote moves a new or open inquiry to
// "Offerte verstuurd" and an accepted quote marks it "Gewonnen". Never reopens a
// closed inquiry for a sent quote, and does nothing when the status already fits (silent moves from planning only go forward).
const moveStatusFromQuote = async (
  client: any,
  inquiryId: string,
  targetKey: "offerte_verstuurd" | "gewonnen",
  actorId: string | null,
) =>
  applyStatusChange(client, inquiryId, targetKey, {
    actorId,
    silent: true,
    onlyFromKinds:
      targetKey === "gewonnen" ? ["NEW", "OPEN", "LOST"] : ["NEW", "OPEN"],
  });

// Called by the planning module (FR-REQ-04): planning a site inspection moves a new
// or open inquiry to "Schouw gepland". Never reopens a closed inquiry.
const moveStatusFromPlanning = async (
  client: any,
  inquiryId: string,
  actorId: string | null,
) =>
  applyStatusChange(client, inquiryId, "schouw_gepland", {
    actorId,
    silent: true,
    onlyFromKinds: ["NEW", "OPEN"],
    onlyForward: true,
  });

// ---------------------------------------------------------------------------
// Photos and files (FR-REQ-02)
// ---------------------------------------------------------------------------

// Used for staff uploads now, and by the form builder and portal for the files
// a customer attaches to their inquiry.
const addPhotos = async (
  inquiryId: string,
  files: any[],
  actorId: string | null,
) => {
  assertUuid(inquiryId, "inquiry id");

  if (!files || files.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No files uploaded!");
  }

  const existing = await query(
    `
      SELECT i.id, (SELECT COUNT(*)::int FROM inquiry_photos p WHERE p.inquiry_id = i.id) AS photo_count
      FROM inquiries i WHERE i.id = $1::uuid
    `,
    [inquiryId],
  );
  if (existing.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Inquiry not found!");
  }
  if (existing.rows[0].photo_count + files.length > MAX_FILES_PER_INQUIRY) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `An inquiry can have at most ${MAX_FILES_PER_INQUIRY} files!`,
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
      uploaded = await S3Uploader.uploadToS3(file, `inquiries/${inquiryId}`);
    } catch (error) {
      throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, "File upload failed.");
    }

    const result = await query(
      `
        INSERT INTO inquiry_photos (inquiry_id, file_url, storage_key, file_name, mime_type, size_bytes, uploaded_by)
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
        RETURNING ${photoColumns}
      `,
      [
        inquiryId,
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

const deletePhoto = async (inquiryId: string, photoId: string) => {
  assertUuid(inquiryId, "inquiry id");
  assertUuid(photoId, "photo id");

  const result = await query(
    `DELETE FROM inquiry_photos WHERE id = $1::uuid AND inquiry_id = $2::uuid RETURNING storage_key`,
    [photoId, inquiryId],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "File not found!");
  }

  // The record is gone either way; a storage hiccup only leaves an unused file behind
  try {
    await S3Uploader.deleteFromS3(result.rows[0].storage_key);
  } catch (error) {
    console.error(
      "❌ Could not delete file from storage:",
      result.rows[0].storage_key,
      error,
    );
  }
};

// ---------------------------------------------------------------------------
// Notes and history
// ---------------------------------------------------------------------------

// A note on an inquiry appears on the inquiry and on the customer's timeline
const addNote = async (inquiryId: string, note: string, actorId: string) => {
  assertUuid(inquiryId, "inquiry id");

  const inquiry = await query(
    `SELECT relation_id FROM inquiries WHERE id = $1::uuid`,
    [inquiryId],
  );
  if (inquiry.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Inquiry not found!");
  }

  const result = await query(
    `
      INSERT INTO relation_timeline (relation_id, event_type, entity_type, entity_id, title, description, actor_id)
      VALUES ($1::uuid, 'NOTE', 'inquiry', $2::uuid, 'Note added', $3, $4::uuid)
      RETURNING id, event_type, entity_type, entity_id, title, description, actor_id, created_at AS "createdAt"
    `,
    [inquiry.rows[0].relation_id, inquiryId, note, actorId],
  );
  return result.rows[0];
};

// Everything that happened to this inquiry: created, status changes, notes
const getHistory = async (inquiryId: string, params: Record<string, any>) => {
  assertUuid(inquiryId, "inquiry id");

  const exists = await query(`SELECT 1 FROM inquiries WHERE id = $1::uuid`, [
    inquiryId,
  ]);
  if (exists.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Inquiry not found!");
  }

  const { page, limit, skip } = paginationHelper.calculatePagination(params);

  const [result, count] = await Promise.all([
    query(
      `
        SELECT t.id, t.event_type, t.title, t.description, t.metadata, t.actor_id,
               u.name AS actor_name, t.created_at AS "createdAt"
        FROM relation_timeline t
        LEFT JOIN users u ON u.id = t.actor_id
        WHERE t.entity_type = 'inquiry' AND t.entity_id = $1::uuid
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $2 OFFSET $3
      `,
      [inquiryId, limit, skip],
    ),
    query(
      `SELECT COUNT(*) AS total FROM relation_timeline WHERE entity_type = 'inquiry' AND entity_id = $1::uuid`,
      [inquiryId],
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

export const InquiryService = {
  createInquiry,
  getAllInquiries,
  getPipeline,
  getSummary,
  getOptions,
  getInquiryById,
  updateInquiry,
  changeStatus,
  moveStatusFromQuote,
  moveStatusFromPlanning,
  addPhotos,
  deletePhoto,
  addNote,
  getHistory,
};
