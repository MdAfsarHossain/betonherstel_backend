import { TLanguage } from "../../utils/i18n";

export const inquirySources = [
  "FORM",
  "WEBHOOK",
  "PORTAL",
  "PHONE",
  "EMAIL",
  "OTHER",
] as const;

export type TInquirySource = (typeof inquirySources)[number];

// Sources office staff may pick when they enter an inquiry by hand (FR-REQ-01)
export const manualSources = ["PHONE", "EMAIL", "OTHER"] as const;

export const statusKinds = ["NEW", "OPEN", "WON", "LOST"] as const;

export type TStatusKind = (typeof statusKinds)[number];

export interface IInquiryAddress {
  street: string;
  house_number: string;
  postcode: string;
  city: string;
  country?: string;
}

// One shape for every way an inquiry arrives: office staff (manual), the form
// builder, the website webhook and the customer portal all call
// InquiryService.createInquiry with this.
export interface ICreateInquiry {
  source: TInquirySource;
  // Existing customer (portal, or office picking one). Without it a relation is
  // found by email (public sources) or created.
  relation_id?: string;
  relation_type?: "PRIVATE" | "BUSINESS" | "VVE";
  company_name?: string;
  contact_name?: string;
  contact_email?: string | null;
  contact_phone?: string | null;
  // Key of a service type, e.g. "balcony_renovation"
  service_type?: string | null;
  description?: string | null;
  address?: IInquiryAddress | null;
  language?: TLanguage;
  assigned_to?: string | null;
  // Idempotency key from the sender (webhook delivery id, form submission id)
  external_ref?: string;
  // Office: create a new relation although likely duplicates exist
  allow_duplicate_relation?: boolean;
  // Send the customer a confirmation email (default true)
  send_confirmation?: boolean;
}

export interface IUpdateInquiry {
  relation_id?: string;
  service_type?: string | null;
  description?: string | null;
  contact_name?: string;
  contact_email?: string | null;
  contact_phone?: string | null;
  address?: IInquiryAddress | null;
  language?: TLanguage;
  assigned_to?: string | null;
}

export interface IChangeStatus {
  status: string;
  lost_reason?: string;
}

export interface ICreateStatus {
  label_nl: string;
  label_en: string;
  kind: "OPEN" | "WON" | "LOST";
  color?: string;
  sort_order?: number;
}

export interface IUpdateStatus {
  label_nl?: string;
  label_en?: string;
  color?: string;
  sort_order?: number;
  is_active?: boolean;
}
