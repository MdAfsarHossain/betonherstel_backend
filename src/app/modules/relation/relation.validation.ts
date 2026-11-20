import z from "zod";
import { relationTypes } from "./relation.interface";

const phoneRegex = /^[+]?[0-9 ()-]{6,20}$/;
const nlPostcodeRegex = /^[1-9][0-9]{3}\s?[A-Za-z]{2}$/;

// IBAN: country code + check digits + BBAN, verified with the ISO 7064 mod-97 check
const isValidIban = (value: string) => {
  const iban = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) =>
    String(ch.charCodeAt(0) - 55),
  );

  // Process in chunks so the number never exceeds safe-integer range
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
};

// Optional text that may be "" or null (forms send "" for untouched fields)
const optionalText = (max: number) => z.string().max(max).nullish();

const optionalEmail = z
  .string()
  .email({ message: "Invalid email format!" })
  .max(255)
  .or(z.literal(""))
  .nullish();

const optionalPhone = z
  .string()
  .regex(phoneRegex, {
    message: "Phone number is not valid. Please enter a valid phone number.",
  })
  .or(z.literal(""))
  .nullish();

const languageSchema = z.enum(["NL", "EN"], {
  error: "Language should be either NL or EN!",
});

const countrySchema = z
  .string()
  .length(2, "Country must be a 2-letter ISO code!")
  .regex(/^[A-Za-z]{2}$/, "Country must be a 2-letter ISO code!");

const kvkSchema = z
  .string()
  .regex(/^[0-9]{8}$/, { message: "KvK number must be 8 digits!" })
  .or(z.literal(""))
  .nullish();

const vatSchema = z
  .string()
  .regex(/^[A-Za-z]{2}[A-Za-z0-9. ]{2,18}$/, {
    message: "VAT number is not valid (for example NL123456789B01)!",
  })
  .or(z.literal(""))
  .nullish();

const ibanSchema = z
  .string()
  .refine((v) => v === "" || isValidIban(v), { message: "IBAN is not valid!" })
  .nullish();

const contactSchema = z.object({
  name: z.string({ error: "Contact name is required!" }).trim().min(1).max(255),
  role: optionalText(100),
  phone: optionalPhone,
  email: optionalEmail,
  is_primary: z.boolean().optional(),
});

const addressSchema = z
  .object({
    label: optionalText(100),
    street: z.string({ error: "Street is required!" }).trim().min(1).max(255),
    house_number: z
      .string({ error: "House number is required!" })
      .trim()
      .min(1)
      .max(20),
    postcode: z
      .string({ error: "Postcode is required!" })
      .trim()
      .min(1)
      .max(12),
    city: z.string({ error: "City is required!" }).trim().min(1).max(100),
    country: countrySchema.optional(),
    notes: z.string().max(2000).nullish(),
  })
  .refine(
    (a) =>
      (a.country ?? "NL").toUpperCase() !== "NL" ||
      nlPostcodeRegex.test(a.postcode),
    { message: "Postcode must look like 1234 AB!", path: ["postcode"] },
  );

// Fields shared by create and update
const relationFields = {
  name: z.string({ error: "Name is required!" }).trim().min(1).max(255),
  email: optionalEmail,
  phone: optionalPhone,
  kvk_number: kvkSchema,
  vat_number: vatSchema,
  iban: ibanSchema,
  payment_term_days: z
    .number()
    .int("Payment term must be a whole number of days!")
    .min(0)
    .max(365)
    .nullish(),
  invoice_email: optionalEmail,
  preferred_language: languageSchema,
  billing_street: optionalText(255),
  billing_house_number: optionalText(20),
  billing_postcode: optionalText(12),
  billing_city: optionalText(100),
  billing_country: countrySchema,
  notes: z.string().max(5000).nullish(),
};

const atMostOnePrimary = (contacts?: { is_primary?: boolean }[]) =>
  !contacts || contacts.filter((c) => c.is_primary).length <= 1;

const createRelation = z.object({
  body: z.object({
    type: z.enum(relationTypes, {
      error: "Type should be one of PRIVATE, BUSINESS, VVE, SUPPLIER or SUBCONTRACTOR!",
    }),
    ...relationFields,
    preferred_language: languageSchema.optional(),
    billing_country: countrySchema.optional(),
    contacts: z
      .array(contactSchema)
      .max(20)
      .refine(atMostOnePrimary, {
        message: "Only one contact can be the primary contact!",
      })
      .optional(),
    addresses: z.array(addressSchema).max(50).optional(),
    allow_duplicate: z.boolean().optional(),
  }),
});

const updateRelation = z.object({
  body: z.object({
    type: z
      .enum(relationTypes, {
        error: "Type should be one of PRIVATE, BUSINESS, VVE, SUPPLIER or SUBCONTRACTOR!",
      })
      .optional(),
    ...relationFields,
    name: relationFields.name.optional(),
    preferred_language: languageSchema.optional(),
    billing_country: countrySchema.optional(),
    is_active: z.boolean().optional(),
  }),
});

// Lightweight pre-check used by the UI while the user is typing
const checkDuplicates = z.object({
  body: z.object({
    email: optionalEmail,
    invoice_email: optionalEmail,
    phone: optionalPhone,
    billing_postcode: optionalText(12),
    billing_house_number: optionalText(20),
    contacts: z
      .array(z.object({ email: optionalEmail, phone: optionalPhone }))
      .max(20)
      .optional(),
    addresses: z
      .array(
        z.object({
          postcode: optionalText(12),
          house_number: optionalText(20),
        }),
      )
      .max(50)
      .optional(),
  }),
});

const createContact = z.object({ body: contactSchema });

const updateContact = z.object({
  body: z.object({
    name: contactSchema.shape.name.optional(),
    role: contactSchema.shape.role,
    phone: contactSchema.shape.phone,
    email: contactSchema.shape.email,
    is_primary: z.boolean().optional(),
  }),
});

const createAddress = z.object({ body: addressSchema });

const updateAddress = z.object({
  body: z
    .object({
      label: optionalText(100),
      street: z.string().trim().min(1).max(255).optional(),
      house_number: z.string().trim().min(1).max(20).optional(),
      postcode: z.string().trim().min(1).max(12).optional(),
      city: z.string().trim().min(1).max(100).optional(),
      country: countrySchema.optional(),
      notes: z.string().max(2000).nullish(),
    })
    .refine(
      (a) =>
        a.postcode === undefined ||
        (a.country ?? "NL").toUpperCase() !== "NL" ||
        nlPostcodeRegex.test(a.postcode),
      { message: "Postcode must look like 1234 AB!", path: ["postcode"] },
    ),
});

const createNote = z.object({
  body: z.object({
    note: z.string({ error: "Note is required!" }).trim().min(1).max(5000),
  }),
});

export const RelationValidation = {
  createRelation,
  updateRelation,
  checkDuplicates,
  createContact,
  updateContact,
  createAddress,
  updateAddress,
  createNote,
};
