import { TUnit } from "../../utils/units";

export const catalogueItemTypes = ["MATERIAL", "LABOUR", "SERVICE"] as const;

export type TCatalogueItemType = (typeof catalogueItemTypes)[number];

export interface ICreateCatalogueItem {
  code?: string | null;
  name: string;
  description?: string | null;
  type?: TCatalogueItemType;
  unit?: TUnit;
  unit_price?: number;
  cost_price?: number;
  vat_code?: string;
  // Key of a service type this catalogue item belongs to
  service_type?: string | null;
}

export type IUpdateCatalogueItem = Partial<ICreateCatalogueItem> & { is_active?: boolean };
