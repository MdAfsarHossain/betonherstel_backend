export const relationTypes = [
  "PRIVATE",
  "BUSINESS",
  "VVE",
  "SUPPLIER",
  "SUBCONTRACTOR",
] as const;

export type TRelationType = (typeof relationTypes)[number];

export type TLanguage = "NL" | "EN";

export interface IRelationContact {
  name: string;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  is_primary?: boolean;
}

export interface IRelationAddress {
  label?: string | null;
  street: string;
  house_number: string;
  postcode: string;
  city: string;
  country?: string;
  notes?: string | null;
}

export interface ICreateRelation {
  type: TRelationType;
  name: string;
  email?: string | null;
  phone?: string | null;
  kvk_number?: string | null;
  vat_number?: string | null;
  iban?: string | null;
  payment_term_days?: number | null;
  invoice_email?: string | null;
  preferred_language?: TLanguage;
  billing_street?: string | null;
  billing_house_number?: string | null;
  billing_postcode?: string | null;
  billing_city?: string | null;
  billing_country?: string;
  notes?: string | null;
  contacts?: IRelationContact[];
  addresses?: IRelationAddress[];
  // Set to true to create the relation although likely duplicates exist
  allow_duplicate?: boolean;
}

export type IUpdateRelation = Partial<
  Omit<ICreateRelation, "contacts" | "addresses" | "allow_duplicate">
> & { is_active?: boolean };

// Input for duplicate detection (FR-REL-06)
export interface IDuplicateCheck {
  email?: string | null;
  invoice_email?: string | null;
  phone?: string | null;
  billing_postcode?: string | null;
  billing_house_number?: string | null;
  contacts?: Pick<IRelationContact, "email" | "phone">[];
  addresses?: Partial<Pick<IRelationAddress, "postcode" | "house_number">>[];
}

// Event written to the relation timeline (FR-REL-05). Other modules
// (inquiries, quotations, invoices...) call `logRelationEvent` with these.
export interface IRelationEvent {
  event_type: string;
  title: string;
  entity_type?: string | null;
  entity_id?: string | null;
  description?: string | null;
  metadata?: Record<string, any>;
  actor_id?: string | null;
}
