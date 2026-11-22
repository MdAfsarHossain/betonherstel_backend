import z from "zod";
import { hasMaxDecimals } from "../../utils/money";
import { isValidDay } from "../../utils/dates";
import { sectionsSchema } from "../quote/quote.validation";
import { invoiceSources, manualPaymentMethods } from "./invoice.interface";

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

const text = (max = 10000) => z.string().max(max).nullish();

const headerFields = {
  title: z.string().trim().max(255).nullish(),
  language: languageSchema.optional(),
  payment_term_days: z
    .number({ error: "Payment term must be a number!" })
    .int()
    .min(0)
    .max(365)
    .optional(),
  recipient_name: z.string().max(255).nullish(),
  recipient_email: optionalEmail,
  intro_text: text(),
  footer_text: text(),
  internal_notes: text(5000),
};

const includeSchema = z
  .object({
    budget: z.boolean().optional(),
    additional: z.boolean().optional(),
    hours: z.boolean().optional(),
  })
  .optional();

const createInvoice = z.object({
  body: z
    .object({
      source: z.enum(invoiceSources, {
        error: "Source should be MANUAL, QUOTE, PROJECT, INSTALMENT or FINAL!",
      }),
      relation_id: uuid("relation id").optional(),
      quote_id: uuid("quote id").optional(),
      project_id: uuid("project id").optional(),
      include: includeSchema,
      percentage: z
        .number({ error: "Percentage must be a number!" })
        .gt(0, "Percentage must be greater than 0!")
        .max(100, "Percentage cannot be more than 100!")
        .refine((v) => hasMaxDecimals(v, 3), {
          message: "Percentage can have at most 3 decimals!",
        })
        .optional(),
      amount: z
        .number({ error: "Amount must be a number!" })
        .gt(0, "Amount must be greater than 0!")
        .max(100_000_000)
        .refine((v) => hasMaxDecimals(v, 2), {
          message: "Amount can have at most 2 decimals!",
        })
        .optional(),
      sections: sectionsSchema.optional(),
      ...headerFields,
    })
    .refine((b) => b.source !== "MANUAL" || !!b.relation_id, {
      message: "A manual invoice needs a relation_id!",
      path: ["relation_id"],
    })
    .refine((b) => b.source !== "QUOTE" || !!b.quote_id, {
      message: "An invoice from a quotation needs a quote_id!",
      path: ["quote_id"],
    })
    .refine(
      (b) =>
        !["PROJECT", "INSTALMENT", "FINAL"].includes(b.source) ||
        !!b.project_id,
      {
        message: "This kind of invoice needs a project_id!",
        path: ["project_id"],
      },
    )
    .refine((b) => b.source !== "INSTALMENT" || !!b.percentage !== !!b.amount, {
      message:
        "An instalment invoice needs a percentage or an amount (not both)!",
      path: ["percentage"],
    })
    .refine((b) => b.source === "INSTALMENT" || (!b.percentage && !b.amount), {
      message: "A percentage or amount is only for instalment invoices!",
      path: ["percentage"],
    })
    .refine((b) => b.source === "MANUAL" || !b.sections, {
      message: "Lines can only be given for a manual invoice!",
      path: ["sections"],
    })
    .refine((b) => ["PROJECT", "FINAL"].includes(b.source) || !b.include, {
      message: "include is only for project and final invoices!",
      path: ["include"],
    }),
});

const updateInvoice = z.object({
  body: z.object(headerFields).refine((b) => Object.keys(b).length > 0, {
    message: "No fields to update",
  }),
});

const setItems = z.object({ body: z.object({ sections: sectionsSchema }) });

const issueInvoice = z.object({
  body: z.object({
    send: z.boolean().optional(),
    email: z
      .string()
      .email({ message: "Invalid email format!" })
      .max(255)
      .optional(),
  }),
});

const sendInvoice = z.object({
  body: z.object({
    email: z
      .string()
      .email({ message: "Invalid email format!" })
      .max(255)
      .optional(),
  }),
});

const createCreditNote = z.object({
  body: z.object({
    reason: z
      .string({ error: "A reason is required!" })
      .trim()
      .min(3)
      .max(1000),
    lines: z
      .array(
        z.object({
          invoice_line_id: uuid("invoice line id"),
          quantity: z
            .number({ error: "Quantity must be a number!" })
            .gt(0, "Quantity must be greater than 0!")
            .max(1_000_000)
            .refine((v) => hasMaxDecimals(v, 3), {
              message: "Quantity can have at most 3 decimals!",
            }),
        }),
      )
      .min(1, "Pick at least one line, or leave lines out for a full credit!")
      .max(500)
      .optional(),
  }),
});

const recordPayment = z.object({
  body: z.object({
    amount: z
      .number({ error: "Amount must be a number!" })
      .gt(0, "Amount must be greater than 0!")
      .max(100_000_000)
      .refine((v) => hasMaxDecimals(v, 2), {
        message: "Amount can have at most 2 decimals!",
      }),
    paid_at: z
      .string()
      .refine(
        (v) =>
          isValidDay(v) ||
          (/(Z|[+-]\d{2}:?\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))),
        {
          message:
            "Use a date like 2026-11-30 or a date-time with a time zone!",
        },
      )
      .optional(),
    method: z
      .enum(manualPaymentMethods, { error: "Method should be BANK or OTHER!" })
      .optional(),
    reference: z.string().trim().max(255).nullish(),
  }),
});

const remind = z.object({
  body: z.object({
    email: z
      .string()
      .email({ message: "Invalid email format!" })
      .max(255)
      .optional(),
  }),
});

const setMollieKey = z.object({
  body: z.object({
    api_key: z
      .string({ error: "The API key is required!" })
      .trim()
      .min(10)
      .max(200),
  }),
});

export const InvoiceValidation = {
  createInvoice,
  updateInvoice,
  setItems,
  issueInvoice,
  sendInvoice,
  createCreditNote,
  recordPayment,
  remind,
  setMollieKey,
};
