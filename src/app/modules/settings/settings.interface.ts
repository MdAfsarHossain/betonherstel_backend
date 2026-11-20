export type TDocType =
  | "inquiry"
  | "project"
  | "assignment"
  | "subscription"
  | "quote"
  | "invoice"
  | "credit_note"
  | "work_order"
  | "purchase_order";

export const docTypes: TDocType[] = [
  "inquiry",
  "project",
  "assignment",
  "subscription",
  "quote",
  "invoice",
  "credit_note",
  "work_order",
  "purchase_order",
];

export interface IVatRate {
  code: string;
  label: string;
  rate: number;
  reverse_charge: boolean;
}

export interface IUpdateCompany {
  company_name?: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  street?: string | null;
  house_number?: string | null;
  postcode?: string | null;
  city?: string | null;
  country?: string;
  kvk_number?: string | null;
  vat_number?: string | null;
  iban?: string | null;
  bic?: string | null;
  bank_name?: string | null;
  default_payment_term_days?: number;
  quote_validity_days?: number;
  quote_followup_days?: number;
  reminder_days_after_due?: number[];
  vat_rates?: IVatRate[];
  number_formats?: Partial<Record<TDocType, string>>;
}
