import { TLanguage } from "../../utils/i18n";
import { TUnit } from "../../utils/units";

export const quoteStatuses = ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"] as const;

export type TQuoteStatus = (typeof quoteStatuses)[number];

// How an acceptance was received. The customer portal records PORTAL; office
// staff record the others (FR-QUO-10: "office staff may also record acceptance").
export const manualAcceptVia = ["PHONE", "EMAIL", "IN_PERSON", "OTHER"] as const;

export type TAcceptVia = "PORTAL" | (typeof manualAcceptVia)[number];

export interface IQuoteAddress {
  street: string;
  house_number: string;
  postcode: string;
  city: string;
  country?: string;
}

// With a catalogue item, description / unit / prices default from the catalogue
export interface IQuoteLineInput {
  catalogue_item_id?: string;
  description?: string;
  quantity: number;
  unit?: TUnit;
  unit_price?: number;
  cost_price?: number;
  vat_code?: string;
}

export interface IQuoteSectionInput {
  title?: string | null;
  lines: IQuoteLineInput[];
}

export interface IQuoteTexts {
  intro_text?: string | null;
  scope_text?: string | null;
  conditions_text?: string | null;
  warranty_text?: string | null;
}

export interface ICreateQuote extends IQuoteTexts {
  inquiry_id?: string;
  relation_id?: string;
  title?: string;
  service_type?: string | null;
  language?: TLanguage;
  valid_until?: string;
  recipient_name?: string | null;
  recipient_email?: string | null;
  address?: IQuoteAddress | null;
  internal_notes?: string | null;
  sections?: IQuoteSectionInput[];
}

export type IUpdateQuote = Omit<ICreateQuote, "inquiry_id" | "relation_id" | "sections">;

export interface ISendQuote {
  // Overrides the recipient on the quotation
  email?: string;
  // false: mark as sent without emailing (handed over in person, sent another way)
  send_email?: boolean;
  // false: do not invite the customer to the portal, even if this is their first quotation (default: invite)
  invite_to_portal?: boolean;
}

export interface IAcceptQuote {
  accepted_by_name: string;
  via: TAcceptVia;
  terms_accepted: boolean;
  ip?: string | null;
}

export interface IUpsertQuoteTemplate extends IQuoteTexts {
  service_type?: string | null;
  language: TLanguage;
}
