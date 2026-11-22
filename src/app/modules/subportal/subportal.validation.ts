import z from "zod";
import { hasMaxDecimals } from "../../utils/money";
import { isValidDay } from "../../utils/dates";

const daySchema = z
  .string()
  .refine(isValidDay, { message: "Date must look like 2026-11-30!" });
const phoneRegex = /^[+]?[0-9 ()-]{6,20}$/;
const phone = z
  .string()
  .regex(phoneRegex, {
    message: "Phone number is not valid. Please enter a valid phone number.",
  });
const text = (max: number) => z.string().trim().max(max);

const respond = z.object({
  body: z
    .object({
      response: z.enum(["CONFIRM", "DECLINE"], {
        error: "Response should be CONFIRM or DECLINE!",
      }),
      comment: text(2000).nullish(),
      proposed_start: daySchema.nullish(),
      proposed_end: daySchema.nullish(),
    })
    .refine(
      (b) => b.response === "DECLINE" || (!b.proposed_start && !b.proposed_end),
      {
        message: "Alternative dates can only be given with a decline!",
        path: ["proposed_start"],
      },
    )
    .refine(
      (b) =>
        !b.proposed_start ||
        !b.proposed_end ||
        b.proposed_end >= b.proposed_start,
      {
        message: "The alternative end date cannot be before the start date!",
        path: ["proposed_end"],
      },
    ),
});

const progress = z.object({
  body: z.object({
    percent: z
      .number({ error: "Percent must be a number!" })
      .int("Percent must be a whole number!")
      .min(0, "Percent cannot be below 0!")
      .max(100, "Percent cannot be above 100!"),
    note: text(2000).nullish(),
  }),
});

const complete = z.object({ body: z.object({ note: text(2000).nullish() }) });

const updateMe = z.object({
  body: z
    .object({
      name: z.string().trim().min(1).max(255).optional(),
      phone_number: phone.nullish(),
      preferred_language: z.enum(["NL", "EN"], { error: "Language should be either NL or EN!" }).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});

// The company's own contact details (FR-SUBP-09)
const updateCompany = z.object({
  body: z
    .object({
      phone: phone.nullish(),
      email: z
        .string()
        .email({ message: "Invalid email format!" })
        .max(255)
        .nullish(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});

// The invoice is uploaded as a form (the PDF plus these fields), so numbers arrive as text
const money = (label: string) =>
  z.coerce
    .number({ error: `${label} must be a number!` })
    .min(-100_000_000)
    .max(100_000_000)
    .refine((v) => hasMaxDecimals(v, 2), {
      message: `${label} can have at most 2 decimals!`,
    });

export const invoiceForm = z.object({
  invoice_number: z
    .string({ error: "The invoice number is required!" })
    .trim()
    .min(1, "The invoice number is required!")
    .max(60),
  invoice_date: daySchema,
  due_date: daySchema.optional().or(z.literal("").transform(() => undefined)),
  amount_excl_vat: money("Amount excl. VAT"),
  vat_amount: money("VAT amount"),
  amount_incl_vat: money("Amount incl. VAT"),
  vat_code: z
    .string()
    .regex(/^[A-Z0-9_-]{1,20}$/, "Invalid VAT code!")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  description: text(5000).optional(),
});

export const SubPortalValidation = {
  respond,
  progress,
  complete,
  updateMe,
  updateCompany,
};
