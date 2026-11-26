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

// Every kind of event on a relation's timeline: the enum "RelationEventType" in the database (config/database.ts
// creates it from this list). A new kind of event is added HERE: it compiles everywhere the type is used, and
// initDatabase() adds it to an existing database with ALTER TYPE ... ADD VALUE IF NOT EXISTS.
export const relationEventTypes = [
  "NOTE",
  "OTHER",
  "RELATION_CREATED",
  "RELATION_REACTIVATED",
  "RELATION_DEACTIVATED",
  "INQUIRY_CREATED",
  "INQUIRY_STATUS_CHANGED",
  "QUOTE_FOLLOW_UP_DUE",
  "QUOTE_EXPIRED",
  "PORTAL_USER_INVITED",
  "PORTAL_USER_REACTIVATED",
  "PORTAL_USER_DEACTIVATED",
  "PORTAL_COMPANY_DETAILS_CHANGED",
  "DIRECT_DEBIT_MANDATE_ACTIVE",
  "DIRECT_DEBIT_MANDATE_REVOKED",
  "DIRECT_DEBIT_FAILED",
  "ASSIGNMENT_CREATED",
  "ASSIGNMENT_PROGRESS",
  "ASSIGNMENT_COMPLETED",
  "ASSIGNMENT_REOPENED",
  "ASSIGNMENT_RESCHEDULED",
  "ASSIGNMENT_CANCELLED",
  "INVOICE_PAYMENT_RECEIVED",
  "PURCHASE_ORDER_SENT",
  "PURCHASE_ORDER_CANCELLED",
  "SUBSCRIPTION_INVOICED",
  "SUBSCRIPTION_VISIT_PLANNED",
  "SUPPLIER_INVOICE_APPROVED",
  "SUPPLIER_INVOICE_UNAPPROVED",
  "SUPPLIER_INVOICE_PAID",
  "SUPPLIER_INVOICE_VOIDED",
  "WORK_ORDER_STARTED",
  "WORK_ORDER_COMPLETED",
  "WORK_ORDER_CHECKED",
  "WORK_ORDER_REOPENED",
  "WORK_ORDER_SENT",
  "WORK_ORDER_DELETED",
  "APPOINTMENT_PLANNED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_REOPENED",
  "APPOINTMENT_COMPLETED",
  "APPOINTMENT_CANCELLED",
  "APPOINTMENT_DELETED",
  "APPOINTMENT_CONFIRMATION_SENT",
  "ASSIGNMENT_SENT",
  "ASSIGNMENT_RESENT",
  "ASSIGNMENT_REMINDER",
  "ASSIGNMENT_CONFIRMED",
  "ASSIGNMENT_DECLINED",
  "ASSIGNMENT_FILES_ADDED",
  "ASSIGNMENT_INVOICE_RECEIVED",
  "ASSIGNMENT_INVOICED",
  "ASSIGNMENT_UNINVOICED",
  "INVOICE_ISSUED",
  "INVOICE_SENT",
  "INVOICE_REMINDER_SENT",
  "INVOICE_PAYMENT_REMOVED",
  "INVOICE_PAYMENT_REVERSED",
  "CREDIT_NOTE_ISSUED",
  "CREDIT_NOTE_SENT",
  "PROJECT_CREATED",
  "PROJECT_DELETED",
  "PROJECT_STATUS_CHANGED",
  "PROJECT_CLOSED",
  "PROJECT_REOPENED",
  "PROJECT_ADDITIONAL_WORK",
  "PURCHASE_ORDER_ORDERED",
  "PURCHASE_ORDER_DELIVERY_DATE_CHANGED",
  "PURCHASE_ORDER_PARTIALLY_RECEIVED",
  "PURCHASE_ORDER_RECEIVED",
  "QUOTE_CREATED",
  "QUOTE_SENT",
  "QUOTE_ACCEPTED",
  "QUOTE_REJECTED",
  "QUOTE_REVISED",
  "QUOTE_DELETED",
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_PAUSED",
  "SUBSCRIPTION_RESUMED",
  "SUBSCRIPTION_ENDED",
  "SUPPLIER_INVOICE_RECEIVED",
  "WORK_ORDER_CREATED",
] as const;
export type TRelationEventType = (typeof relationEventTypes)[number];

// Event written to the relation timeline (FR-REL-05). Other modules
// (inquiries, quotations, invoices...) call `logRelationEvent` with these.
export interface IRelationEvent {
  event_type: TRelationEventType;
  title: string;
  entity_type?: string | null;
  entity_id?: string | null;
  description?: string | null;
  metadata?: Record<string, any>;
  actor_id?: string | null;
}
