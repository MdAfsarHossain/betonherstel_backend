import { TLanguage } from "../../utils/i18n";
import { TUnit } from "../../utils/units";

export const purchaseOrderStatuses = ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"] as const;
export type TPurchaseOrderStatus = (typeof purchaseOrderStatuses)[number];

// Ontvangen (received), Goedgekeurd (approved), Betaald (paid); VOID is an entry made by mistake
export const supplierInvoiceStatuses = ["RECEIVED", "APPROVED", "PAID", "VOID"] as const;
export type TSupplierInvoiceStatus = (typeof supplierInvoiceStatuses)[number];

export interface IPurchaseLineInput {
  catalogue_item_id?: string;
  description?: string;
  quantity: number;
  unit?: TUnit;
  // The price we pay. With a catalogue item it defaults to its cost price.
  unit_price?: number;
  vat_code?: string;
}

export interface IDeliveryAddress {
  street: string;
  house_number: string;
  postcode: string;
  city: string;
  country?: string;
}

export interface IPurchaseOrderHeader {
  project_id?: string | null;
  title?: string | null;
  supplier_reference?: string | null;
  language?: TLanguage;
  expected_delivery_date?: string | null;
  delivery_address?: IDeliveryAddress | null;
  recipient_name?: string | null;
  recipient_email?: string | null;
  notes?: string | null;
  internal_notes?: string | null;
}

export interface ICreatePurchaseOrder extends IPurchaseOrderHeader {
  supplier_id: string;
  lines?: IPurchaseLineInput[];
}

export type IUpdatePurchaseOrder = IPurchaseOrderHeader;

export interface IOrderPurchaseOrder {
  send?: boolean;
  email?: string;
}

export interface IReceiveGoods {
  // Quantities per line, or everything that is still outstanding
  lines?: { line_id: string; quantity: number }[];
  all?: boolean;
}

export interface ISupplierInvoiceFields {
  purchase_order_id?: string | null;
  project_id?: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date?: string | null;
  amount_excl_vat: number;
  vat_amount: number;
  amount_incl_vat: number;
  vat_code?: string | null;
  description?: string | null;
  internal_notes?: string | null;
}

export interface ICreateSupplierInvoice extends ISupplierInvoiceFields {
  supplier_id: string;
  // Set when the invoice is a subcontractor's invoice for an assignment (FR-SUB-04)
  subcontract_assignment_id?: string | null;
}

export type IUpdateSupplierInvoice = Partial<ISupplierInvoiceFields>;

export interface IPaySupplierInvoice {
  paid_at?: string;
  reference?: string | null;
}

export interface IActor {
  id: string;
  role: string;
}
