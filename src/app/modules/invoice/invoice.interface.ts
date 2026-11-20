import { TLanguage } from "../../utils/i18n";
import { IQuoteSectionInput } from "../quote/quote.interface";

export const invoiceKinds = ["STANDARD", "INSTALMENT", "FINAL", "CREDIT_NOTE"] as const;
export type TInvoiceKind = (typeof invoiceKinds)[number];

export const invoiceSources = ["MANUAL", "QUOTE", "PROJECT", "INSTALMENT", "FINAL"] as const;
export type TInvoiceSource = (typeof invoiceSources)[number];

export const invoiceStatuses = ["DRAFT", "ISSUED"] as const;
export type TInvoiceStatus = (typeof invoiceStatuses)[number];

// Open, Partly paid, Paid, and Credited (nothing left to pay because it was credited)
export const paymentStatuses = ["OPEN", "PARTIALLY_PAID", "PAID", "CREDITED"] as const;
export type TPaymentStatus = (typeof paymentStatuses)[number];

export const manualPaymentMethods = ["BANK", "OTHER"] as const;

export interface IInvoiceHeader {
  title?: string | null;
  language?: TLanguage;
  payment_term_days?: number;
  recipient_name?: string | null;
  recipient_email?: string | null;
  intro_text?: string | null;
  footer_text?: string | null;
  internal_notes?: string | null;
}

export interface ICreateInvoice extends IInvoiceHeader {
  // Where the lines come from (FR-INV-01, FR-INV-02)
  source: TInvoiceSource;
  relation_id?: string;
  quote_id?: string;
  project_id?: string;
  // PROJECT and FINAL: which parts of the project to invoice
  include?: { budget?: boolean; additional?: boolean; hours?: boolean };
  // INSTALMENT: a percentage or an amount (excl. VAT) of the project budget
  percentage?: number;
  amount?: number;
  // MANUAL
  sections?: IQuoteSectionInput[];
}

export type IUpdateInvoice = IInvoiceHeader;

export interface IIssueInvoice {
  // Email it to the customer straight away
  send?: boolean;
  email?: string;
}

export interface ICreateCreditNote {
  reason: string;
  // Leave out for a full credit; give lines (and quantities) for a partial one
  lines?: { invoice_line_id: string; quantity: number }[];
}

export interface IRecordPayment {
  amount: number;
  paid_at?: string;
  method?: "BANK" | "OTHER";
  reference?: string | null;
}
