import z from "zod";
import { hasMaxDecimals } from "../../utils/money";
import { isValidDay } from "../../utils/dates";

const uuid = (label: string) => z.string().uuid({ message: `Invalid ${label}!` });

const daySchema = z.string().refine(isValidDay, { message: "Date must look like 2026-11-30!" });

// A supplier credit note is entered with negative amounts
const amount = (label: string) =>
  z
    .number({ error: `${label} must be a number!` })
    .min(-100_000_000)
    .max(100_000_000)
    .refine((v) => hasMaxDecimals(v, 2), { message: `${label} can have at most 2 decimals!` });

const fields = {
  purchase_order_id: uuid("purchase order id").nullish(),
  project_id: uuid("project id").nullish(),
  invoice_number: z.string({ error: "The invoice number is required!" }).trim().min(1).max(60),
  invoice_date: daySchema,
  due_date: daySchema.nullish(),
  amount_excl_vat: amount("Amount excl. VAT"),
  vat_amount: amount("VAT amount"),
  amount_incl_vat: amount("Amount incl. VAT"),
  vat_code: z.string().regex(/^[A-Z0-9_-]{1,20}$/, "Invalid VAT code!").nullish(),
  description: z.string().max(5000).nullish(),
  internal_notes: z.string().max(5000).nullish(),
};

const createSupplierInvoice = z.object({
  body: z.object({ supplier_id: uuid("supplier id"), subcontract_assignment_id: uuid("assignment id").nullish(), ...fields }),
});

const updateSupplierInvoice = z.object({
  body: z
    .object({
      purchase_order_id: fields.purchase_order_id,
      project_id: fields.project_id,
      invoice_number: fields.invoice_number.optional(),
      invoice_date: fields.invoice_date.optional(),
      due_date: fields.due_date,
      amount_excl_vat: fields.amount_excl_vat.optional(),
      vat_amount: fields.vat_amount.optional(),
      amount_incl_vat: fields.amount_incl_vat.optional(),
      vat_code: fields.vat_code,
      description: fields.description,
      internal_notes: fields.internal_notes,
    })
    .refine((b) => Object.keys(b).length > 0, { message: "No fields to update" }),
});

const paySupplierInvoice = z.object({
  body: z.object({
    paid_at: daySchema.optional(),
    reference: z.string().trim().max(255).nullish(),
  }),
});

const voidSupplierInvoice = z.object({
  body: z.object({ reason: z.string({ error: "A reason is required!" }).trim().min(3).max(1000) }),
});

export const SupplierInvoiceValidation = {
  createSupplierInvoice,
  updateSupplierInvoice,
  paySupplierInvoice,
  voidSupplierInvoice,
};
