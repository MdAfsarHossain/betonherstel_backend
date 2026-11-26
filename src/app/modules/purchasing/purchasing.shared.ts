import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import assertUuid from "../../utils/assertUuid";
import { query } from "../../utils/db";
import { fromCents, lineAmountCents, toCents } from "../../utils/money";
import normalizePostcode from "../../utils/normalizePostcode";
import { calculateTotals } from "../quote/quote.calculation";
import { RelationService } from "../relation/relation.service";
import { SettingsService } from "../settings/settings.service";
import { IDeliveryAddress, IPurchaseLineInput } from "./purchasing.interface";
import { TRelationEventType } from "../relation/relation.interface";

// Pieces shared by the purchase order and supplier invoice services.

export const clean = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : (value ?? null);

export const run = (client?: any) => (client ? client.query.bind(client) : query);

export const round2 = (n: number) => Math.round(n * 100) / 100;

// Today in Amsterdam, as SQL
export const todaySql = `(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Amsterdam')::date`;

export const normalizeAddress = (a: IDeliveryAddress) => ({
  street: a.street.trim(),
  house_number: a.house_number.trim(),
  postcode: normalizePostcode(a.postcode),
  city: a.city.trim(),
  country: (a.country ?? "NL").toUpperCase(),
});

// A supplier is a relation of type SUPPLIER
export const loadSupplier = async (client: any, id: string, mustBeActive = true, type: "SUPPLIER" | "SUBCONTRACTOR" = "SUPPLIER") => {
  assertUuid(id, "supplier id");
  const result = await client.query(
    `
      SELECT r.id, r.type::text AS type, r.name, r.email, r.preferred_language::text AS preferred_language, r.is_active,
             pc.name AS contact_name, pc.email AS contact_email
      FROM relations r
      LEFT JOIN relation_contacts pc ON pc.relation_id = r.id AND pc.is_primary
      WHERE r.id = $1::uuid
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Supplier not found!");
  }
  const supplier = result.rows[0];
  if (supplier.type !== type) {
    throw new ApiError(httpStatus.BAD_REQUEST, type === "SUPPLIER" ? "This relation is not a supplier!" : "This relation is not a subcontractor!");
  }
  if (mustBeActive && !supplier.is_active) {
    throw new ApiError(httpStatus.BAD_REQUEST, "This supplier is deactivated!");
  }
  return supplier;
};

export interface IPreparedLine {
  catalogue_item_id: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  vat_code: string;
  vat_rate: number;
  vat_reverse_charge: boolean;
}

// Fills the gaps from the catalogue (the price we pay is its cost price), fixes the VAT rate
// to its current value and checks the amounts.
export const prepareLines = async (items: IPurchaseLineInput[]): Promise<IPreparedLine[]> => {
  const company = await SettingsService.getCompanySettings();
  const vatRates: { code: string; rate: number; reverse_charge: boolean }[] = company.vat_rates;
  const defaultVat = (vatRates.find((v) => v.code === "21") ?? vatRates.find((v) => !v.reverse_charge) ?? vatRates[0]).code;

  const ids = [...new Set(items.map((i) => i.catalogue_item_id).filter(Boolean) as string[])];
  const catalogue = new Map<string, any>();
  if (ids.length > 0) {
    const found = await query(
      `SELECT id, name, description, unit, unit_price::float8 AS unit_price, cost_price::float8 AS cost_price, vat_code, is_active
       FROM catalogue_items WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of found.rows) catalogue.set(row.id, row);
  }

  return items.map((line, i) => {
    const where = `Line ${i + 1}`;
    const item = line.catalogue_item_id ? catalogue.get(line.catalogue_item_id) : null;
    if (line.catalogue_item_id && !item) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${where}: catalogue item not found!`);
    }
    if (item && !item.is_active) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${where}: the catalogue item is no longer available!`);
    }

    const description = clean(line.description) ?? item?.description ?? item?.name;
    const unit = line.unit ?? item?.unit;
    // What we pay: the cost price (the selling price is not what a supplier charges us)
    const unitPrice = line.unit_price ?? (item ? (item.cost_price > 0 ? item.cost_price : item.unit_price) : undefined);
    if (!description || !unit || unitPrice === undefined) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${where}: description, unit and unit price are required!`);
    }

    const vatCode = line.vat_code ?? item?.vat_code ?? defaultVat;
    const vat = vatRates.find((v) => v.code === vatCode);
    if (!vat) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${where}: unknown VAT code ${vatCode}!`);
    }
    if (Math.abs(lineAmountCents(line.quantity, toCents(unitPrice))) > 100_000_000 * 100) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${where}: the amount is too large!`);
    }

    return {
      catalogue_item_id: line.catalogue_item_id ?? null,
      description: String(description),
      quantity: line.quantity,
      unit,
      unit_price: unitPrice,
      vat_code: vat.code,
      vat_rate: vat.rate,
      vat_reverse_charge: vat.reverse_charge,
    };
  });
};

export const insertLines = async (client: any, purchaseOrderId: string, lines: IPreparedLine[]) => {
  const next = await client.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM purchase_order_lines WHERE purchase_order_id = $1::uuid`,
    [purchaseOrderId],
  );
  let order = Number(next.rows[0].next);
  for (const l of lines) {
    await client.query(
      `
        INSERT INTO purchase_order_lines (
          purchase_order_id, sort_order, catalogue_item_id, description, quantity, unit, unit_price,
          vat_code, vat_rate, vat_reverse_charge, line_total
        ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        purchaseOrderId,
        order++,
        l.catalogue_item_id,
        l.description,
        l.quantity,
        l.unit,
        l.unit_price,
        l.vat_code,
        l.vat_rate,
        l.vat_reverse_charge,
        fromCents(lineAmountCents(l.quantity, toCents(l.unit_price))),
      ],
    );
  }
};

// Writes the stored totals from the lines (VAT once per rate, in cents)
export const recomputeTotals = async (client: any, purchaseOrderId: string) => {
  const lines = await client.query(
    `SELECT quantity::float8 AS quantity, unit_price::float8 AS unit_price, vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge
     FROM purchase_order_lines WHERE purchase_order_id = $1::uuid`,
    [purchaseOrderId],
  );
  const totals = calculateTotals(lines.rows.map((l: any) => ({ ...l, cost_price: 0 })));
  await client.query(
    `UPDATE purchase_orders SET total_excl_vat = $2, total_vat = $3, total_incl_vat = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
    [purchaseOrderId, fromCents(totals.subtotalCents), fromCents(totals.totalVatCents), fromCents(totals.totalCents)],
  );
  return totals;
};

// Locks the row (a single-table select, never a join) so requests take turns
export const lockPurchaseOrder = async (client: any, id: string) => {
  assertUuid(id, "purchase order id");
  const result = await client.query(
    `
      SELECT id, number, status, supplier_id, project_id, language::text AS language,
             total_excl_vat::float8 AS total_excl_vat, total_incl_vat::float8 AS total_incl_vat
      FROM purchase_orders WHERE id = $1::uuid FOR UPDATE
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Purchase order not found!");
  }
  return result.rows[0];
};

// What happened, on the supplier's timeline
export const logPurchasingEvent = (
  client: any,
  supplierId: string,
  entity: { type: "purchase_order" | "supplier_invoice"; id: string },
  eventType: TRelationEventType,
  title: string,
  actorId: string | null,
  extra: { description?: string | null; metadata?: Record<string, any> } = {},
) =>
  RelationService.logRelationEvent(
    supplierId,
    {
      event_type: eventType,
      entity_type: entity.type,
      entity_id: entity.id,
      title,
      description: extra.description ?? null,
      metadata: extra.metadata,
      actor_id: actorId,
    },
    client,
  );
