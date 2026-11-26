import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { query, transaction } from "../../utils/db";
import assertUuid from "../../utils/assertUuid";
import normalizePostcode from "../../utils/normalizePostcode";
import { buildInsert, buildUpdate } from "../../utils/sqlBuilders";
import { paginationHelper } from "../../helpers/paginationHelper";
import {
  ICreateRelation,
  IDuplicateCheck,
  IRelationAddress,
  IRelationContact,
  IRelationEvent,
  IUpdateRelation,
  relationTypes,
} from "./relation.interface";

// ---------------------------------------------------------------------------
// Columns and field whitelists
// ---------------------------------------------------------------------------

// Portal status of a relation (invitation sent? has anyone logged in?), shared by the list and the detail.
// `pu` is the aggregate of the relation's portal accounts (customer and subcontractor users).
const portalSummarySelect = `
  json_build_object(
    'state', CASE
      WHEN pu.users = 0 THEN 'NOT_INVITED'
      WHEN pu.active_with_password > 0 THEN 'ACTIVE'
      WHEN pu.active_without_password > 0 THEN 'INVITED'
      ELSE 'DEACTIVATED' END,
    'users', pu.users,
    'invited', pu.invited_at IS NOT NULL,
    'invited_at', pu.invited_at,
    'has_logged_in', pu.last_login_at IS NOT NULL,
    'last_login_at', pu.last_login_at
  ) AS portal`;
const portalSummaryJoin = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS users,
           COUNT(*) FILTER (WHERE u.is_active AND u.password IS NOT NULL)::int AS active_with_password,
           COUNT(*) FILTER (WHERE u.is_active AND u.password IS NULL)::int AS active_without_password,
           MAX(u.portal_invited_at) AS invited_at,
           MAX(u.last_login_at) AS last_login_at
    FROM users u
    WHERE u.relation_id = r.id AND u.role::text IN ('CUSTOMER', 'SUBCONTRACTOR')
  ) pu ON true`;

// The list shows only the main facts; GET /relations/:id has everything
const relationSummaryColumns = (alias = "r") => `
  ${alias}.id,
  ${alias}.type,
  ${alias}.name,
  ${alias}.email,
  ${alias}.phone,
  ${alias}.billing_city,
  ${alias}.is_active,
  ${alias}.created_at as "createdAt"
`;

const relationColumns = (alias = "r") => `
  ${alias}.id,
  ${alias}.type,
  ${alias}.name,
  ${alias}.email,
  ${alias}.phone,
  ${alias}.kvk_number,
  ${alias}.vat_number,
  ${alias}.iban,
  ${alias}.payment_term_days,
  ${alias}.invoice_email,
  ${alias}.preferred_language,
  ${alias}.billing_street,
  ${alias}.billing_house_number,
  ${alias}.billing_postcode,
  ${alias}.billing_city,
  ${alias}.billing_country,
  ${alias}.notes,
  ${alias}.snelstart_relation_id,
  ${alias}.is_active,
  ${alias}.is_imported,
  ${alias}.created_by,
  ${alias}.created_at as "createdAt",
  ${alias}.updated_at as "updatedAt"
`;

const contactColumns = `
  id,
  relation_id,
  name,
  role,
  phone,
  email,
  is_primary,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const addressColumns = `
  id,
  relation_id,
  label,
  street,
  house_number,
  postcode,
  city,
  country,
  notes,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

// column -> optional SQL cast
const relationInsertFields = {
  type: '::"RelationType"',
  name: "",
  email: "",
  phone: "",
  kvk_number: "",
  vat_number: "",
  iban: "",
  payment_term_days: "",
  invoice_email: "",
  preferred_language: '::"Language"',
  billing_street: "",
  billing_house_number: "",
  billing_postcode: "",
  billing_city: "",
  billing_country: "",
  notes: "",
};

const relationUpdateFields = { ...relationInsertFields, is_active: "" };

const contactFields = {
  name: "",
  role: "",
  phone: "",
  email: "",
  is_primary: "",
};

const addressFields = {
  label: "",
  street: "",
  house_number: "",
  postcode: "",
  city: "",
  country: "",
  notes: "",
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

// "" -> null so cleared form fields are stored as NULL, not empty strings
const emptyToNull = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : value;

const normalizeFields = (payload: Record<string, any>) => {
  const data: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    data[key] = emptyToNull(value);
  }

  for (const key of ["email", "invoice_email"]) {
    if (typeof data[key] === "string") data[key] = data[key].toLowerCase();
  }
  if (typeof data.kvk_number === "string") {
    data.kvk_number = data.kvk_number.replace(/\s/g, "");
  }
  if (typeof data.vat_number === "string") {
    data.vat_number = data.vat_number.replace(/[\s.]/g, "").toUpperCase();
  }
  if (typeof data.iban === "string") {
    data.iban = data.iban.replace(/\s/g, "").toUpperCase();
  }
  for (const key of ["billing_postcode", "postcode"]) {
    if (typeof data[key] === "string") data[key] = normalizePostcode(data[key]);
  }
  for (const key of ["billing_country", "country"]) {
    if (typeof data[key] === "string") data[key] = data[key].toUpperCase();
  }

  return data;
};

// Strips formatting so "+31 6 12345678" and "06-12345678" compare equal.
// The SQL twin of this lives in `phoneSql`; keep both in sync.
const normalizePhone = (phone?: string | null) => {
  if (!phone) return "";
  return phone.replace(/[^0-9]/g, "").replace(/^(00)?31/, "0");
};

const phoneSql = (column: string) =>
  `regexp_replace(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), '^(00)?31', '0')`;

// ---------------------------------------------------------------------------
// Timeline (FR-REL-05)
// ---------------------------------------------------------------------------

// Writes an event to a relation's timeline. Other modules call this when
// something happens to the relation (quote sent, invoice paid, ...). Pass a
// transaction `client` to make the event part of the caller's transaction.
const logRelationEvent = async (
  relationId: string,
  event: IRelationEvent,
  client?: any,
) => {
  const run = client ? client.query.bind(client) : query;

  await run(
    `
        INSERT INTO relation_timeline (
            relation_id, event_type, entity_type, entity_id,
            title, description, metadata, actor_id
        ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8::uuid)
    `,
    [
      relationId,
      event.event_type,
      event.entity_type ?? null,
      event.entity_id ?? null,
      event.title,
      event.description ?? null,
      JSON.stringify(event.metadata ?? {}),
      event.actor_id ?? null,
    ],
  );
};

// ---------------------------------------------------------------------------
// Duplicate detection (FR-REL-06)
// ---------------------------------------------------------------------------

// Finds relations that share an email, phone number, or postcode + house
// number with the given data. Contact persons and object addresses count too.
const findDuplicates = async (input: IDuplicateCheck, exceptId?: string) => {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const postcodes: string[] = [];
  const houseNumbers: string[] = [];

  const addEmail = (email?: string | null) => {
    const value = emptyToNull(email);
    if (value) emails.add(String(value).toLowerCase());
  };
  const addPhone = (phone?: string | null) => {
    const value = normalizePhone(emptyToNull(phone));
    // Very short numbers match too much to be meaningful
    if (value.length >= 6) phones.add(value);
  };
  const addAddress = (postcode?: string | null, houseNumber?: string | null) => {
    const pc = emptyToNull(postcode);
    const nr = emptyToNull(houseNumber);
    if (pc && nr) {
      postcodes.push(String(pc).replace(/\s/g, "").toUpperCase());
      houseNumbers.push(String(nr).toLowerCase());
    }
  };

  addEmail(input.email);
  addEmail(input.invoice_email);
  addPhone(input.phone);
  addAddress(input.billing_postcode, input.billing_house_number);
  input.contacts?.forEach((c) => {
    addEmail(c.email);
    addPhone(c.phone);
  });
  input.addresses?.forEach((a) => addAddress(a.postcode, a.house_number));

  if (emails.size === 0 && phones.size === 0 && postcodes.length === 0) {
    return [];
  }

  const result = await query(
    `
        SELECT r.id, r.type, r.name, r.email, r.phone, r.billing_city, r.is_active
        FROM relations r
        WHERE ($5::uuid IS NULL OR r.id != $5::uuid)
            AND (
                LOWER(r.email) = ANY($1::text[])
                OR LOWER(r.invoice_email) = ANY($1::text[])
                OR ${phoneSql("r.phone")} = ANY($2::text[])
                OR EXISTS (
                    SELECT 1 FROM relation_contacts c
                    WHERE c.relation_id = r.id
                        AND (
                            LOWER(c.email) = ANY($1::text[])
                            OR ${phoneSql("c.phone")} = ANY($2::text[])
                        )
                )
                OR EXISTS (
                    SELECT 1 FROM unnest($3::text[], $4::text[]) AS p(pc, nr)
                    WHERE p.pc = UPPER(REPLACE(r.billing_postcode, ' ', ''))
                        AND p.nr = LOWER(r.billing_house_number)
                )
                OR EXISTS (
                    SELECT 1
                    FROM relation_addresses a,
                        unnest($3::text[], $4::text[]) AS p(pc, nr)
                    WHERE a.relation_id = r.id
                        AND p.pc = UPPER(REPLACE(a.postcode, ' ', ''))
                        AND p.nr = LOWER(a.house_number)
                )
            )
        ORDER BY r.name
        LIMIT 10
    `,
    [
      Array.from(emails),
      Array.from(phones),
      postcodes,
      houseNumbers,
      exceptId ?? null,
    ],
  );

  return result.rows;
};

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

const getRelationOrThrow = async (id: string) => {
  assertUuid(id, "relation id");

  const result = await query(
    `SELECT ${relationColumns("r")} FROM relations r WHERE r.id = $1::uuid`,
    [id],
  );

  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Relation not found!");
  }

  return result.rows[0];
};

// Relation with its contact persons and object addresses
const getRelationById = async (id: string) => {
  const relation = await getRelationOrThrow(id);

  const [contacts, addresses, portal, accounts] = await Promise.all([
    query(
      `SELECT ${contactColumns} FROM relation_contacts
       WHERE relation_id = $1::uuid
       ORDER BY is_primary DESC, name ASC`,
      [id],
    ),
    query(
      `SELECT ${addressColumns} FROM relation_addresses
       WHERE relation_id = $1::uuid
       ORDER BY created_at ASC`,
      [id],
    ),
    query(
      `SELECT ${portalSummarySelect} FROM relations r ${portalSummaryJoin} WHERE r.id = $1::uuid`,
      [id],
    ),
    // The portal accounts themselves: who was invited, who has set a password, who logged in
    query(
      `SELECT u.id, u.name, u.email, u.role::text AS role,
              CASE WHEN NOT u.is_active THEN 'DEACTIVATED' WHEN u.password IS NULL THEN 'INVITED' ELSE 'ACTIVE' END AS state,
              u.portal_invited_at AS invited_at, u.last_login_at
       FROM users u
       WHERE u.relation_id = $1::uuid AND u.role::text IN ('CUSTOMER', 'SUBCONTRACTOR')
       ORDER BY u.created_at ASC`,
      [id],
    ),
  ]);

  return {
    ...relation,
    contacts: contacts.rows,
    addresses: addresses.rows,
    portal: { ...portal.rows[0].portal, accounts: accounts.rows },
  };
};

// Create a relation. If likely duplicates exist and `allow_duplicate` is not
// set, nothing is created and the duplicates are returned so the user can
// open an existing relation or confirm.
// Inserts a relation with its contact persons, object addresses and timeline
// event using the caller's transaction `client`. Other modules (inquiries) use it
// to create a relation as part of their own transaction. Returns the new id.
const createRelationInTransaction = async (
  client: any,
  payload: Omit<ICreateRelation, "allow_duplicate">,
  actorId: string | null,
): Promise<string> => {
  const { contacts = [], addresses = [], ...rest } = payload;

  const data = normalizeFields(rest);
  const contactRows = contacts.map((c) => normalizeFields(c));
  const addressRows = addresses.map((a) => normalizeFields(a));

  const insert = buildInsert(data, relationInsertFields);
  insert.columns.push("created_by");
  insert.placeholders.push(`$${insert.paramCount}::uuid`);
  insert.values.push(actorId);

  const created = await client.query(
    `
        INSERT INTO relations (${insert.columns.join(", ")})
        VALUES (${insert.placeholders.join(", ")})
        RETURNING id
      `,
    insert.values,
  );
  const id = created.rows[0].id as string;

  for (const contact of contactRows) {
    const c = buildInsert(contact, contactFields, 2);
    await client.query(
      `INSERT INTO relation_contacts (relation_id, ${c.columns.join(", ")})
         VALUES ($1::uuid, ${c.placeholders.join(", ")})`,
      [id, ...c.values],
    );
  }

  for (const address of addressRows) {
    const a = buildInsert(address, addressFields, 2);
    await client.query(
      `INSERT INTO relation_addresses (relation_id, ${a.columns.join(", ")})
         VALUES ($1::uuid, ${a.placeholders.join(", ")})`,
      [id, ...a.values],
    );
  }

  await logRelationEvent(
    id,
    {
      event_type: "RELATION_CREATED",
      entity_type: "relation",
      entity_id: id,
      title: "Relation created",
      actor_id: actorId,
    },
    client,
  );

  return id;
};

const createRelation = async (payload: ICreateRelation, actorId: string | null) => {
  const { allow_duplicate, ...rest } = payload;

  if (!allow_duplicate) {
    const data = normalizeFields({ ...rest, contacts: undefined, addresses: undefined });
    const duplicates = await findDuplicates({
      email: data.email,
      invoice_email: data.invoice_email,
      phone: data.phone,
      billing_postcode: data.billing_postcode,
      billing_house_number: data.billing_house_number,
      contacts: (rest.contacts ?? []).map((c) => normalizeFields(c)),
      addresses: (rest.addresses ?? []).map((a) => normalizeFields(a)),
    });

    if (duplicates.length > 0) {
      return { created: false as const, duplicates };
    }
  }

  const relationId = await transaction((client) =>
    createRelationInTransaction(client, rest, actorId),
  );

  return { created: true as const, relation: await getRelationById(relationId) };
};

// Most recent active relation that has this exact email (relation, invoice
// email or one of its contact persons). Used to link public inquiries to an
// existing customer instead of creating a duplicate.
const findActiveByEmail = async (email: string, client?: any) => {
  const run = client ? client.query.bind(client) : query;
  const result = await run(
    `
        SELECT r.id, r.type, r.name, r.preferred_language
        FROM relations r
        WHERE r.is_active
            AND (
                LOWER(r.email) = $1
                OR LOWER(r.invoice_email) = $1
                OR EXISTS (
                    SELECT 1 FROM relation_contacts c
                    WHERE c.relation_id = r.id AND LOWER(c.email) = $1
                )
            )
        ORDER BY r.created_at DESC
        LIMIT 1
    `,
    [email.trim().toLowerCase()],
  );
  return result.rows[0] ?? null;
};

// Builds the WHERE clause shared by the list and the CSV export
const buildListFilter = (params: Record<string, any>) => {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const asString = (v: any) => String(Array.isArray(v) ? v[0] : v).trim();

  if (params.searchTerm) {
    // Escape LIKE wildcards so a search for "50%" is literal
    const term = asString(params.searchTerm).replace(/[\\%_]/g, "\\$&");
    conditions.push(
      `(
        r.name ILIKE $${paramCount}
        OR r.email ILIKE $${paramCount}
        OR r.phone ILIKE $${paramCount}
        OR r.billing_city ILIKE $${paramCount}
        OR r.billing_postcode ILIKE $${paramCount}
        OR r.kvk_number ILIKE $${paramCount}
        OR r.vat_number ILIKE $${paramCount}
        OR EXISTS (
          SELECT 1 FROM relation_contacts c
          WHERE c.relation_id = r.id
            AND (c.name ILIKE $${paramCount} OR c.email ILIKE $${paramCount} OR c.phone ILIKE $${paramCount})
        )
      )`,
    );
    values.push(`%${term}%`);
    paramCount++;
  }

  if (params.type) {
    const type = asString(params.type).toUpperCase();
    if (!(relationTypes as readonly string[]).includes(type)) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Invalid relation type!");
    }
    conditions.push(`r.type = $${paramCount++}::"RelationType"`);
    values.push(type);
  }

  if (params.preferred_language) {
    const language = asString(params.preferred_language).toUpperCase();
    if (language !== "NL" && language !== "EN") {
      throw new ApiError(httpStatus.BAD_REQUEST, "Invalid language!");
    }
    conditions.push(`r.preferred_language = $${paramCount++}::"Language"`);
    values.push(language);
  }

  if (params.city) {
    conditions.push(`r.billing_city ILIKE $${paramCount++}`);
    values.push(asString(params.city).replace(/[\\%_]/g, "\\$&"));
  }

  // Active relations only, unless the caller asks for archived ones or "all"
  const isActive = params.is_active === undefined ? "true" : asString(params.is_active);
  if (isActive !== "all") {
    conditions.push(`r.is_active = $${paramCount++}`);
    values.push(isActive === "true");
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
    paramCount,
  };
};

// Search / filter / paginate (FR-REL-07). Searching and paging run in SQL so
// the list stays fast with tens of thousands of relations.
const getAllRelations = async (params: Record<string, any>) => {
  const { page, limit, skip, sortBy, sortOrder } =
    paginationHelper.calculatePagination(params);

  // Sort column / direction go into the SQL text, so only whitelisted values are allowed
  const sortableColumns: Record<string, string> = {
    created_at: "r.created_at",
    updated_at: "r.updated_at",
    name: "LOWER(r.name)",
    type: "r.type",
    billing_city: "r.billing_city",
  };
  const orderColumn = sortableColumns[sortBy] ?? "r.created_at";
  const orderDirection = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  const { whereClause, values, paramCount } = buildListFilter(params);

  const result = await query(
    `
        SELECT ${relationSummaryColumns("r")},
               ${portalSummarySelect}
        FROM relations r
        ${portalSummaryJoin}
        ${whereClause}
        ORDER BY ${orderColumn} ${orderDirection}, r.id ASC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `,
    [...values, limit, skip],
  );

  const countResult = await query(
    `SELECT COUNT(*) as total FROM relations r ${whereClause}`,
    values,
  );

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

// Update a relation's own fields (contacts / addresses have their own endpoints)
const updateRelation = async (
  id: string,
  payload: IUpdateRelation,
  actorId: string,
) => {
  const existing = await getRelationOrThrow(id);

  const data = normalizeFields(payload);
  const { updates, values, paramCount } = buildUpdate(
    data,
    relationUpdateFields,
  );

  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  await transaction(async (client) => {
    await client.query(
      `UPDATE relations SET ${updates.join(", ")} WHERE id = $${paramCount}::uuid`,
      values,
    );

    if (data.is_active !== undefined && data.is_active !== existing.is_active) {
      await logRelationEvent(
        id,
        {
          event_type: data.is_active ? "RELATION_REACTIVATED" : "RELATION_DEACTIVATED",
          entity_type: "relation",
          entity_id: id,
          title: data.is_active ? "Relation reactivated" : "Relation deactivated",
          actor_id: actorId,
        },
        client,
      );
    }
  });

  return getRelationById(id);
};

// ---------------------------------------------------------------------------
// CSV export (FR-REL-07, Beheerder only)
// ---------------------------------------------------------------------------

// Quotes a CSV cell. Cells starting with = + - @ are prefixed with ' so a
// spreadsheet never executes them as a formula (CSV injection).
const csvCell = (value: any, delimiter: string) => {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return text.includes(delimiter) || /["\r\n]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
};

const exportRelationsCsv = async (params: Record<string, any>) => {
  const delimiter = params.delimiter === "semicolon" ? ";" : ",";
  const { whereClause, values } = buildListFilter(params);

  const result = await query(
    `
        SELECT ${relationColumns("r")}
        FROM relations r
        ${whereClause}
        ORDER BY LOWER(r.name) ASC, r.id ASC
    `,
    values,
  );

  const columns: [string, string][] = [
    ["name", "Name"],
    ["type", "Type"],
    ["email", "Email"],
    ["phone", "Phone"],
    ["kvk_number", "KvK"],
    ["vat_number", "VAT"],
    ["iban", "IBAN"],
    ["payment_term_days", "Payment term (days)"],
    ["invoice_email", "Invoice email"],
    ["preferred_language", "Language"],
    ["billing_street", "Billing street"],
    ["billing_house_number", "Billing house number"],
    ["billing_postcode", "Billing postcode"],
    ["billing_city", "Billing city"],
    ["billing_country", "Billing country"],
    ["is_active", "Active"],
    ["createdAt", "Created at"],
  ];

  const lines = [
    columns.map(([, label]) => csvCell(label, delimiter)).join(delimiter),
    ...result.rows.map((row) =>
      columns.map(([key]) => csvCell(row[key], delimiter)).join(delimiter),
    ),
  ];

  // BOM so Excel opens the file as UTF-8
  return `﻿${lines.join("\r\n")}\r\n`;
};

// ---------------------------------------------------------------------------
// Contact persons (FR-REL-02)
// ---------------------------------------------------------------------------

const createContact = async (relationId: string, payload: IRelationContact) => {
  await getRelationOrThrow(relationId);
  const data = normalizeFields(payload);

  const contactId = await transaction(async (client) => {
    // Only one primary contact per relation
    if (data.is_primary) {
      await client.query(
        `UPDATE relation_contacts SET is_primary = false, updated_at = CURRENT_TIMESTAMP
         WHERE relation_id = $1::uuid AND is_primary`,
        [relationId],
      );
    }

    const c = buildInsert(data, contactFields, 2);
    const created = await client.query(
      `INSERT INTO relation_contacts (relation_id, ${c.columns.join(", ")})
       VALUES ($1::uuid, ${c.placeholders.join(", ")})
       RETURNING id`,
      [relationId, ...c.values],
    );
    return created.rows[0].id as string;
  });

  const result = await query(
    `SELECT ${contactColumns} FROM relation_contacts WHERE id = $1::uuid`,
    [contactId],
  );
  return result.rows[0];
};

const updateContact = async (
  relationId: string,
  contactId: string,
  payload: Partial<IRelationContact>,
) => {
  assertUuid(relationId, "relation id");
  assertUuid(contactId, "contact id");

  const data = normalizeFields(payload);
  const { updates, values, paramCount } = buildUpdate(data, contactFields);

  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);

  const updated = await transaction(async (client) => {
    const existing = await client.query(
      `SELECT id FROM relation_contacts
       WHERE id = $1::uuid AND relation_id = $2::uuid FOR UPDATE`,
      [contactId, relationId],
    );
    if (existing.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Contact not found!");
    }

    if (data.is_primary) {
      await client.query(
        `UPDATE relation_contacts SET is_primary = false, updated_at = CURRENT_TIMESTAMP
         WHERE relation_id = $1::uuid AND is_primary AND id != $2::uuid`,
        [relationId, contactId],
      );
    }

    const result = await client.query(
      `UPDATE relation_contacts SET ${updates.join(", ")}
       WHERE id = $${paramCount}::uuid AND relation_id = $${paramCount + 1}::uuid
       RETURNING ${contactColumns}`,
      [...values, contactId, relationId],
    );
    return result.rows[0];
  });

  return updated;
};

const deleteContact = async (relationId: string, contactId: string) => {
  assertUuid(relationId, "relation id");
  assertUuid(contactId, "contact id");

  const result = await query(
    `DELETE FROM relation_contacts
     WHERE id = $1::uuid AND relation_id = $2::uuid RETURNING id`,
    [contactId, relationId],
  );

  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Contact not found!");
  }
};

// ---------------------------------------------------------------------------
// Object addresses (FR-REL-03)
// ---------------------------------------------------------------------------

const createAddress = async (relationId: string, payload: IRelationAddress) => {
  await getRelationOrThrow(relationId);
  const data = normalizeFields(payload);

  const a = buildInsert(data, addressFields, 2);
  const result = await query(
    `INSERT INTO relation_addresses (relation_id, ${a.columns.join(", ")})
     VALUES ($1::uuid, ${a.placeholders.join(", ")})
     RETURNING ${addressColumns}`,
    [relationId, ...a.values],
  );
  return result.rows[0];
};

const updateAddress = async (
  relationId: string,
  addressId: string,
  payload: Partial<IRelationAddress>,
) => {
  assertUuid(relationId, "relation id");
  assertUuid(addressId, "address id");

  const data = normalizeFields(payload);

  // street, house_number, postcode and city are NOT NULL in the table
  for (const required of ["street", "house_number", "postcode", "city"]) {
    if (data[required] === null) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${required} cannot be empty!`);
    }
  }

  const { updates, values, paramCount } = buildUpdate(data, addressFields);

  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);

  const result = await query(
    `UPDATE relation_addresses SET ${updates.join(", ")}
     WHERE id = $${paramCount}::uuid AND relation_id = $${paramCount + 1}::uuid
     RETURNING ${addressColumns}`,
    [...values, addressId, relationId],
  );

  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Address not found!");
  }

  return result.rows[0];
};

const deleteAddress = async (relationId: string, addressId: string) => {
  assertUuid(relationId, "relation id");
  assertUuid(addressId, "address id");

  const result = await query(
    `DELETE FROM relation_addresses
     WHERE id = $1::uuid AND relation_id = $2::uuid RETURNING id`,
    [addressId, relationId],
  );

  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Address not found!");
  }
};

// ---------------------------------------------------------------------------
// Notes and timeline (FR-REL-05)
// ---------------------------------------------------------------------------

const addNote = async (relationId: string, note: string, actorId: string) => {
  await getRelationOrThrow(relationId);

  const result = await query(
    `
        INSERT INTO relation_timeline (
            relation_id, event_type, entity_type, title, description, actor_id
        ) VALUES ($1::uuid, 'NOTE', 'note', 'Note added', $2, $3::uuid)
        RETURNING id, relation_id, event_type, entity_type, entity_id, title,
            description, metadata, actor_id, created_at as "createdAt"
    `,
    [relationId, note, actorId],
  );

  return result.rows[0];
};

const getTimeline = async (relationId: string, params: Record<string, any>) => {
  await getRelationOrThrow(relationId);

  const { page, limit, skip } = paginationHelper.calculatePagination(params);

  const [result, countResult] = await Promise.all([
    query(
      `
        SELECT
            t.id,
            t.event_type,
            t.entity_type,
            t.entity_id,
            t.title,
            t.description,
            t.metadata,
            t.actor_id,
            u.name as actor_name,
            t.created_at as "createdAt"
        FROM relation_timeline t
        LEFT JOIN users u ON u.id = t.actor_id
        WHERE t.relation_id = $1::uuid
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $2 OFFSET $3
      `,
      [relationId, limit, skip],
    ),
    query(
      `SELECT COUNT(*) as total FROM relation_timeline WHERE relation_id = $1::uuid`,
      [relationId],
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

export const RelationService = {
  createRelation,
  createRelationInTransaction,
  findActiveByEmail,
  getAllRelations,
  getRelationById,
  updateRelation,
  findDuplicates,
  exportRelationsCsv,
  createContact,
  updateContact,
  deleteContact,
  createAddress,
  updateAddress,
  deleteAddress,
  addNote,
  getTimeline,
  logRelationEvent,
};
