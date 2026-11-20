import z from "zod";
import {
  templateKeys,
  templateVariables,
} from "../../utils/email/defaultTemplates";
import { docTypes } from "./settings.interface";

const isValidIban = (value: string) => {
  const iban = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const numeric = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (ch) =>
    String(ch.charCodeAt(0) - 55),
  );
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
};

const optionalText = (max: number) => z.string().max(max).nullish();
const optionalEmail = z
  .string()
  .email({ message: "Invalid email format!" })
  .max(255)
  .or(z.literal(""))
  .nullish();

const vatRateSchema = z
  .object({
    code: z
      .string()
      .regex(/^[A-Z0-9_-]{1,20}$/, "VAT code must be 1-20 characters: A-Z, 0-9, _ or -"),
    label: z.string().trim().min(1).max(50),
    rate: z.number().min(0).max(100),
    reverse_charge: z.boolean(),
  })
  .refine((v) => !v.reverse_charge || v.rate === 0, {
    message: "A reverse-charge (BTW verlegd) rate must be 0%!",
    path: ["rate"],
  });

// "{YYYY}-{NNNN}": needs a counter ({N}, {NN}, ...), may have {YYYY} or {YY}
const numberFormat = z
  .string()
  .max(40)
  .regex(/^[A-Za-z0-9\-_/.{}]+$/, "Only letters, digits and - _ / . { } are allowed!")
  .refine((f) => /\{N{1,9}\}/.test(f), {
    message: "Format needs a counter such as {NNNN}!",
  })
  .refine(
    (f) => (f.match(/\{N+\}/g) || []).length === 1,
    { message: "Format must contain exactly one counter!" },
  );

const updateCompany = z.object({
  body: z.object({
    company_name: z.string().trim().min(1).max(255).optional(),
    email: optionalEmail,
    phone: optionalText(50),
    website: optionalText(255),
    street: optionalText(255),
    house_number: optionalText(20),
    postcode: optionalText(12),
    city: optionalText(100),
    country: z.string().regex(/^[A-Za-z]{2}$/, "Country must be a 2-letter ISO code!").optional(),
    kvk_number: z
      .string()
      .regex(/^[0-9]{8}$/, "KvK number must be 8 digits!")
      .or(z.literal(""))
      .nullish(),
    vat_number: z
      .string()
      .regex(/^[A-Za-z]{2}[A-Za-z0-9. ]{2,18}$/, "VAT number is not valid (for example NL123456789B01)!")
      .or(z.literal(""))
      .nullish(),
    iban: z
      .string()
      .refine((v) => v === "" || isValidIban(v), { message: "IBAN is not valid!" })
      .nullish(),
    bic: z
      .string()
      .regex(/^[A-Za-z]{4}[A-Za-z]{2}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/, "BIC is not valid!")
      .or(z.literal(""))
      .nullish(),
    bank_name: optionalText(100),
    default_payment_term_days: z.number().int().min(0).max(365).optional(),
    quote_validity_days: z.number().int().min(1).max(365).optional(),
    quote_followup_days: z.number().int().min(1).max(90).optional(),
    reminder_days_after_due: z
      .array(z.number().int().min(1).max(365))
      .min(1)
      .max(10)
      .optional(),
    vat_rates: z
      .array(vatRateSchema)
      .min(1)
      .max(20)
      .refine((rates) => new Set(rates.map((r) => r.code)).size === rates.length, {
        message: "VAT codes must be unique!",
      })
      .optional(),
    // Any subset of the document types; the rest keep their current format
    number_formats: z
      .object(
        Object.fromEntries(docTypes.map((d) => [d, numberFormat.optional()])) as Record<
          (typeof docTypes)[number],
          z.ZodOptional<typeof numberFormat>
        >,
      )
      .strict()
      .optional(),
  }),
});

const templateKey = z.enum(templateKeys);
const language = z.enum(["NL", "EN"]);

// Rejects script tags, inline event handlers and javascript: links
const safeHtml = (html: string) =>
  !/<\s*script|on[a-z]+\s*=|javascript:/i.test(html);

const updateEmailTemplate = z
  .object({
    body: z.object({
      subject: z.string().trim().min(1).max(255),
      body_html: z
        .string()
        .trim()
        .min(1)
        .max(20000)
        .refine(safeHtml, { message: "Scripts and inline event handlers are not allowed!" }),
    }),
  });

// {{fields}} used in a template must be ones the sender provides (catches typos)
export const unknownMergeFields = (
  key: (typeof templateKeys)[number],
  ...texts: string[]
) => {
  const allowed = new Set([...templateVariables[key], "company_name"]);
  const used = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) used.add(m[1]);
  }
  return [...used].filter((f) => !allowed.has(f));
};

const createServiceType = z.object({
  body: z.object({
    label_nl: z.string({ error: "Dutch label is required!" }).trim().min(1).max(100),
    label_en: z.string({ error: "English label is required!" }).trim().min(1).max(100),
    sort_order: z.number().int().min(0).max(10000).optional(),
  }),
});

const updateServiceType = z.object({
  body: z.object({
    label_nl: z.string().trim().min(1).max(100).optional(),
    label_en: z.string().trim().min(1).max(100).optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    is_active: z.boolean().optional(),
  }),
});

export const SettingsValidation = {
  createServiceType,
  updateServiceType,
  updateCompany,
  updateEmailTemplate,
  templateKey,
  language,
};
