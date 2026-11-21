import z from "zod";
import { hasMaxDecimals } from "../../utils/money";
import { isValidDay } from "../../utils/dates";
import { units } from "../../utils/units";
import { addressSchema } from "../inquiry/inquiry.validation";

const uuid = (label: string) => z.string().uuid({ message: `Invalid ${label}!` });

const daySchema = z.string().refine(isValidDay, { message: "Date must look like 2026-11-30!" });

const optionalEmail = z
  .string()
  .email({ message: "Invalid email format!" })
  .max(255)
  .or(z.literal(""))
  .nullish();

const languageSchema = z.enum(["NL", "EN"], { error: "Language should be either NL or EN!" });

const lineSchema = z
  .object({
    catalogue_item_id: uuid("catalogue item id").optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    quantity: z
      .number({ error: "Quantity must be a number!" })
      .gt(0, "Quantity must be greater than 0!")
      .max(1_000_000, "Quantity is too high!")
      .refine((v) => hasMaxDecimals(v, 3), { message: "Quantity can have at most 3 decimals!" }),
    unit: z.enum(units, { error: "Unit should be one of m, m2, m3, piece, hour or lump_sum!" }).optional(),
    unit_price: z
      .number({ error: "Unit price must be a number!" })
      .min(0, "Unit price cannot be negative!")
      .max(10_000_000)
      .refine((v) => hasMaxDecimals(v, 2), { message: "Unit price can have at most 2 decimals!" })
      .optional(),
    vat_code: z.string().regex(/^[A-Z0-9_-]{1,20}$/, "Invalid VAT code!").optional(),
  })
  .refine((l) => l.catalogue_item_id || (l.description && l.unit && l.unit_price !== undefined), {
    message: "A line needs a catalogue item, or a description, unit and unit price!",
    path: ["description"],
  });

const linesSchema = z.array(lineSchema).max(200, "At most 200 lines!");

const headerFields = {
  project_id: uuid("project id").nullish(),
  title: z.string().trim().max(255).nullish(),
  supplier_reference: z.string().trim().max(100).nullish(),
  language: languageSchema.optional(),
  expected_delivery_date: daySchema.nullish(),
  delivery_address: addressSchema.nullish(),
  recipient_name: z.string().max(255).nullish(),
  recipient_email: optionalEmail,
  notes: z.string().max(5000).nullish(),
  internal_notes: z.string().max(5000).nullish(),
};

const createPurchaseOrder = z.object({
  body: z.object({
    supplier_id: uuid("supplier id"),
    ...headerFields,
    lines: linesSchema.optional(),
  }),
});

const updatePurchaseOrder = z.object({
  body: z.object(headerFields).refine((b) => Object.keys(b).length > 0, { message: "No fields to update" }),
});

const setLines = z.object({ body: z.object({ lines: linesSchema }) });

const orderPurchaseOrder = z.object({
  body: z.object({
    send: z.boolean().optional(),
    email: z.string().email({ message: "Invalid email format!" }).max(255).optional(),
  }),
});

const sendPurchaseOrder = z.object({
  body: z.object({ email: z.string().email({ message: "Invalid email format!" }).max(255).optional() }),
});

const receiveGoods = z.object({
  body: z
    .object({
      all: z.boolean().optional(),
      lines: z
        .array(
          z.object({
            line_id: uuid("line id"),
            quantity: z
              .number({ error: "Quantity must be a number!" })
              .gt(0, "Quantity must be greater than 0!")
              .max(1_000_000)
              .refine((v) => hasMaxDecimals(v, 3), { message: "Quantity can have at most 3 decimals!" }),
          }),
        )
        .min(1, "Pick at least one line!")
        .max(200)
        .optional(),
    })
    .refine((b) => !!b.all !== !!b.lines, { message: "Give the lines received, or all: true!", path: ["lines"] }),
});

const cancelPurchaseOrder = z.object({
  body: z.object({ reason: z.string({ error: "A reason is required!" }).trim().min(3).max(1000) }),
});

export const PurchaseOrderValidation = {
  createPurchaseOrder,
  updatePurchaseOrder,
  setLines,
  orderPurchaseOrder,
  sendPurchaseOrder,
  receiveGoods,
  cancelPurchaseOrder,
};
