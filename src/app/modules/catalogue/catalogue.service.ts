import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { query, transaction } from "../../utils/db";
import { buildInsert, buildUpdate } from "../../utils/sqlBuilders";
import { resolveServiceTypeId } from "../../utils/serviceTypes";
import { SettingsService } from "../settings/settings.service";
import { catalogueItemTypes, ICreateCatalogueItem, IUpdateCatalogueItem } from "./catalogue.interface";

// Catalogue (FR-QUO-03): standard materials, labour rates and service
// descriptions, reused as quotation lines. An admin manages it
// (FR-SET-04); office staff pick from it when building a quotation.

// Prices go out as numbers (the database returns NUMERIC as text)
const catalogueItemColumns = `
  a.id,
  a.code,
  a.name,
  a.description,
  a.type,
  a.unit,
  a.unit_price::float8 AS unit_price,
  a.cost_price::float8 AS cost_price,
  a.vat_code,
  a.is_active,
  CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object(
    'id', st.id, 'key', st.key, 'label_nl', st.label_nl, 'label_en', st.label_en
  ) END AS service_type,
  a.created_at AS "createdAt",
  a.updated_at AS "updatedAt"
`;

const catalogueItemJoins = `LEFT JOIN service_types st ON st.id = a.service_type_id`;

const clean = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : (value ?? null);

const assertVatCode = async (code: string) => {
  const company = await SettingsService.getCompanySettings();
  if (!company.vat_rates.some((r: any) => r.code === code)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Unknown VAT code ${code}!`);
  }
};

const getCatalogueItemById = async (id: string) => {
  assertUuid(id, "catalogue item id");
  const result = await query(
    `SELECT ${catalogueItemColumns} FROM catalogue_items a ${catalogueItemJoins} WHERE a.id = $1::uuid`,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Catalogue item not found!");
  }
  return result.rows[0];
};

const getAllCatalogueItems = async (params: Record<string, any>) => {
  const { page, limit, skip, sortBy: requestedSort, sortOrder } = paginationHelper.calculatePagination(params);
  // A catalogue reads best A-Z, so that is the default (the helper's own default is newest first)
  const sortBy = params.sortBy ? requestedSort : "name";

  const sortable: Record<string, string> = {
    created_at: "a.created_at",
    name: "LOWER(a.name)",
    code: "a.code",
    unit_price: "a.unit_price",
    type: "a.type",
  };
  const orderColumn = sortable[sortBy] ?? "LOWER(a.name)";
  const orderDirection = (params.sortBy ? sortOrder.toLowerCase() : "asc") === "desc" ? "DESC" : "ASC";

  const conditions: string[] = [];
  const values: any[] = [];
  let paramCount = 1;
  const asString = (v: any) => String(Array.isArray(v) ? v[0] : v).trim();

  if (params.searchTerm) {
    const term = asString(params.searchTerm).replace(/[\\%_]/g, "\\$&");
    conditions.push(
      `(a.name ILIKE $${paramCount} OR a.code ILIKE $${paramCount} OR a.description ILIKE $${paramCount})`,
    );
    values.push(`%${term}%`);
    paramCount++;
  }

  if (params.type) {
    const type = asString(params.type).toUpperCase();
    if (!(catalogueItemTypes as readonly string[]).includes(type)) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Invalid catalogue item type!");
    }
    conditions.push(`a.type = $${paramCount++}`);
    values.push(type);
  }

  if (params.service_type) {
    conditions.push(`st.key = $${paramCount++}`);
    values.push(asString(params.service_type));
  }

  // Active catalogue items only, unless the caller asks for inactive ones or "all"
  const isActive = params.is_active === undefined ? "true" : asString(params.is_active);
  if (isActive !== "all") {
    conditions.push(`a.is_active = $${paramCount++}`);
    values.push(isActive === "true");
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [result, count] = await Promise.all([
    query(
      `
        SELECT ${catalogueItemColumns}
        FROM catalogue_items a ${catalogueItemJoins}
        ${whereClause}
        ORDER BY ${orderColumn} ${orderDirection}, a.id ASC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      `,
      [...values, limit, skip],
    ),
    query(`SELECT COUNT(*) AS total FROM catalogue_items a ${catalogueItemJoins} ${whereClause}`, values),
  ]);

  const total = parseInt(count.rows[0].total);
  const totalPage = Math.ceil(total / limit);

  return {
    data: result.rows,
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

const toRow = async (payload: IUpdateCatalogueItem) => {
  const data: Record<string, any> = {};
  if (payload.code !== undefined) data.code = clean(payload.code)?.toUpperCase() ?? null;
  if (payload.name !== undefined) data.name = payload.name.trim();
  if (payload.description !== undefined) data.description = clean(payload.description);
  if (payload.type !== undefined) data.type = payload.type;
  if (payload.unit !== undefined) data.unit = payload.unit;
  if (payload.unit_price !== undefined) data.unit_price = payload.unit_price;
  if (payload.cost_price !== undefined) data.cost_price = payload.cost_price;
  if (payload.vat_code !== undefined) {
    await assertVatCode(payload.vat_code);
    data.vat_code = payload.vat_code;
  }
  if (payload.service_type !== undefined) {
    data.service_type_id = await resolveServiceTypeId(payload.service_type);
  }
  if (payload.is_active !== undefined) data.is_active = payload.is_active;
  return data;
};

const fields = {
  code: "",
  name: "",
  description: "",
  type: "",
  unit: "",
  unit_price: "",
  cost_price: "",
  vat_code: "",
  service_type_id: "::uuid",
  is_active: "",
};

const assertCodeFree = async (code: string, exceptId?: string) => {
  const existing = await query(
    `SELECT 1 FROM catalogue_items WHERE code = $1 AND ($2::uuid IS NULL OR id != $2::uuid)`,
    [code, exceptId ?? null],
  );
  if (existing.rows.length > 0) {
    throw new ApiError(httpStatus.CONFLICT, "A catalogue item with this code already exists!");
  }
};

const createCatalogueItem = async (payload: ICreateCatalogueItem, actorId: string) => {
  const data = await toRow(payload);
  if (data.code) await assertCodeFree(data.code);

  const insert = buildInsert(data, fields);

  const id = await transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO catalogue_items (${insert.columns.join(", ")}) VALUES (${insert.placeholders.join(", ")}) RETURNING id`,
      insert.values,
    );
    await logAudit(
      { actor_id: actorId, action: "CREATE", entity_type: "catalogue_item", entity_id: result.rows[0].id, changes: { name: data.name, code: data.code ?? null } },
      client,
    );
    return result.rows[0].id as string;
  });

  return getCatalogueItemById(id);
};

// Catalogue items are never deleted (old quotations point at them); deactivate instead
const updateCatalogueItem = async (id: string, payload: IUpdateCatalogueItem, actorId: string) => {
  const before = await getCatalogueItemById(id);
  const data = await toRow(payload);
  if (data.code) await assertCodeFree(data.code, id);

  const { updates, values, paramCount } = buildUpdate(data, fields);
  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }
  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  await transaction(async (client) => {
    await client.query(`UPDATE catalogue_items SET ${updates.join(", ")} WHERE id = $${paramCount}::uuid`, values);
    await logAudit(
      { actor_id: actorId, action: "UPDATE", entity_type: "catalogue_item", entity_id: id, changes: { name: before.name, ...payload } },
      client,
    );
  });

  return getCatalogueItemById(id);
};

export const CatalogueService = {
  getAllCatalogueItems,
  getCatalogueItemById,
  createCatalogueItem,
  updateCatalogueItem,
};
