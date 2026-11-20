import { IQuoteAddress, IQuoteSectionInput } from "../quote/quote.interface";
import { TUnit } from "../../utils/units";

export const projectFolders = ["BEFORE", "DURING", "AFTER", "GENERAL"] as const;
export type TProjectFolder = (typeof projectFolders)[number];

export type TProjectStatusKind = "NEW" | "OPEN" | "CLOSED";

export interface ICreateProject {
  // Start from an accepted quotation (copies customer, address and the budget lines)
  quote_id?: string;
  // ...or create one by hand for a customer
  relation_id?: string;
  title?: string;
  description?: string | null;
  service_type?: string | null;
  address?: IQuoteAddress | null;
  planned_start?: string | null;
  planned_end?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  project_manager_id?: string | null;
  internal_notes?: string | null;
  // Only for a manual project: the budget lines
  sections?: IQuoteSectionInput[];
}

export type IUpdateProject = Omit<ICreateProject, "quote_id" | "relation_id" | "sections">;

export interface IChangeProjectStatus {
  status: string;
  note?: string | null;
}

export interface IAdditionalWorkInput {
  section_title?: string | null;
  catalogue_item_id?: string;
  description?: string;
  quantity: number;
  unit?: TUnit;
  unit_price?: number;
  cost_price?: number;
  vat_code?: string;
}

export interface ICreateProjectStatus {
  label_nl: string;
  label_en: string;
  kind: "OPEN" | "CLOSED";
  color?: string;
  sort_order?: number;
}

export interface IUpdateProjectStatus {
  label_nl?: string;
  label_en?: string;
  color?: string;
  sort_order?: number;
  is_active?: boolean;
}
