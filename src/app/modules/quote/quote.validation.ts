import z from "zod";
import { hasMaxDecimals } from "../../utils/money";
import { isValidDay } from "../../utils/dates";
import { units } from "../../utils/units";
import { manualAcceptVia } from "./quote.interface";
import { addressSchema } from "../inquiry/inquiry.validation";

const uuid = (label: string) =>
  z.string().uuid({ message: `Invalid ${label}!` });

const optionalEmail = z
  .string()
  .email({ message: "Invalid email format!" })
  .max(255)
  .or(z.literal(""))
  .nullish();

const languageSchema = z.enum(["NL", "EN"], {
  error: "Language should be either NL or EN!",
});

const daySchema = z
  .string()
  .refine(isValidDay, { message: "Date must look like 2026-11-30!" });

const text = (max = 10000) => z.string().max(max).nullish();

// One quotation line. With a catalogue item, description, unit and prices default from the catalogue.
const lineSchema = z
  .object({
    catalogue_item_id: uuid("catalogue item id").optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    quantity: z
      .number({ error: "Quantity must be a number!" })
      .gt(0, "Quantity must be greater than 0!")
      .max(1_000_000, "Quantity is too high!")
      .refine((v) => hasMaxDecimals(v, 3), {
        message: "Quantity can have at most 3 decimals!",
      }),
    unit: z
      .enum(units, {
        error: "Unit should be one of m, m2, m3, piece, hour or lump_sum!",
      })
      .optional(),
    // Negative prices are allowed for discount lines
    unit_price: z
      .number({ error: "Unit price must be a number!" })
      .min(-10_000_000)
      .max(10_000_000)
      .refine((v) => hasMaxDecimals(v, 2), {
        message: "Unit price can have at most 2 decimals!",
      })
      .optional(),
    cost_price: z
      .number({ error: "Cost price must be a number!" })
      .min(0, "Cost price cannot be negative!")
      .max(10_000_000)
      .refine((v) => hasMaxDecimals(v, 2), {
        message: "Cost price can have at most 2 decimals!",
      })
      .optional(),
    vat_code: z
      .string()
      .regex(/^[A-Z0-9_-]{1,20}$/, "Invalid VAT code!")
      .optional(),
  })
  .refine(
    (l) =>
      l.catalogue_item_id ||
      (l.description && l.unit && l.unit_price !== undefined),
    {
      message:
        "A line needs a catalogue item, or a description, unit and unit price!",
      path: ["description"],
    },
  );

export const sectionsSchema = z
  .array(
    z.object({
      title: z.string().trim().max(255).nullish(),
      lines: z
        .array(lineSchema)
        .min(1, "A section needs at least one line!")
        .max(200),
    }),
  )
  .max(30, "At most 30 sections!")
  .refine(
    (sections) => sections.reduce((n, s) => n + s.lines.length, 0) <= 500,
    {
      message: "At most 500 lines per quotation!",
    },
  );

const headerFields = {
  title: z.string().trim().min(1).max(255).optional(),
  service_type: z.string().max(50).nullish(),
  language: languageSchema.optional(),
  valid_until: daySchema.optional(),
  recipient_name: z.string().max(255).nullish(),
  recipient_email: optionalEmail,
  address: addressSchema.nullish(),
  intro_text: text(),
  scope_text: text(),
  conditions_text: text(),
  warranty_text: text(),
  internal_notes: text(5000),
};

const createQuote = z.object({
  body: z
    .object({
      inquiry_id: uuid("inquiry id").optional(),
      relation_id: uuid("relation id").optional(),
      ...headerFields,
      sections: sectionsSchema.optional(),
    })
    .refine((b) => b.inquiry_id || b.relation_id, {
      message:
        "A quotation needs a customer (relation_id) or an inquiry (inquiry_id)!",
      path: ["relation_id"],
    }),
});

const updateQuote = z.object({
  body: z.object(headerFields),
});

const setItems = z.object({
  body: z.object({ sections: sectionsSchema }),
});

const sendQuote = z.object({
  body: z.object({
    email: z
      .string()
      .email({ message: "Invalid email format!" })
      .max(255)
      .optional(),
    send_email: z.boolean().optional(),
    invite_to_portal: z.boolean().optional(),
  }),
});

// Recording an acceptance needs the name of who accepted and their agreement
// to the terms, the same as the customer portal asks (FR-PORT-04)
const acceptQuote = z.object({
  body: z.object({
    accepted_by_name: z
      .string({ error: "The name of who accepted is required!" })
      .trim()
      .min(2)
      .max(255),
    via: z
      .enum(manualAcceptVia, {
        error: "Via should be one of PHONE, EMAIL, IN_PERSON or OTHER!",
      })
      .optional(),
    terms_accepted: z.literal(true, {
      error: "The customer must have agreed to the terms and conditions!",
    }),
  }),
});

const rejectQuote = z.object({
  body: z.object({
    reason: z.string().trim().max(2000).optional(),
  }),
});

const upsertTemplate = z.object({
  body: z.object({
    service_type: z.string().max(50).nullish(),
    language: languageSchema,
    intro_text: text(),
    scope_text: text(),
    conditions_text: text(),
    warranty_text: text(),
  }),
});

export const QuoteValidation = {
  createQuote,
  updateQuote,
  setItems,
  sendQuote,
  acceptQuote,
  rejectQuote,
  upsertTemplate,
};
