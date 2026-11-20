import z from "zod";
import { manualSources } from "./inquiry.interface";

const phoneRegex = /^[+]?[0-9 ()-]{6,20}$/;
const nlPostcodeRegex = /^[1-9][0-9]{3}\s?[A-Za-z]{2}$/;

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

export const addressSchema = z
  .object({
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
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, "Country must be a 2-letter ISO code!")
      .optional(),
  })
  .refine(
    (a) =>
      (a.country ?? "NL").toUpperCase() !== "NL" ||
      nlPostcodeRegex.test(a.postcode),
    { message: "Postcode must look like 1234 AB!", path: ["postcode"] },
  );

const uuid = (label: string) =>
  z.string().uuid({ message: `Invalid ${label}!` });

// Office staff entering an inquiry by hand (phone or email)
const createInquiry = z.object({
  body: z
    .object({
      source: z
        .enum(manualSources, {
          error: "Source should be one of PHONE, EMAIL or OTHER!",
        })
        .optional(),
      relation_id: uuid("relation id").optional(),
      relation_type: z.enum(["PRIVATE", "BUSINESS", "VVE"]).optional(),
      company_name: optionalText(255),
      contact_name: z.string().trim().min(1).max(255).optional(),
      contact_email: optionalEmail,
      contact_phone: optionalPhone,
      service_type: z.string().max(50).nullish(),
      description: optionalText(5000),
      address: addressSchema.nullish(),
      language: languageSchema.optional(),
      assigned_to: uuid("user id").nullish(),
      allow_duplicate_relation: z.boolean().optional(),
      send_confirmation: z.boolean().optional(),
    })
    // A new customer needs a name and some way to reach them
    .refine((b) => b.relation_id || b.contact_name, {
      message: "Contact name is required!",
      path: ["contact_name"],
    })
    .refine((b) => b.relation_id || b.contact_email || b.contact_phone, {
      message: "An email or phone number is required!",
      path: ["contact_email"],
    }),
});

const updateInquiry = z.object({
  body: z.object({
    relation_id: uuid("relation id").optional(),
    service_type: z.string().max(50).nullish(),
    description: optionalText(5000),
    contact_name: z.string().trim().min(1).max(255).optional(),
    contact_email: optionalEmail,
    contact_phone: optionalPhone,
    address: addressSchema.nullish(),
    language: languageSchema.optional(),
    assigned_to: uuid("user id").nullish(),
  }),
});

const changeStatus = z.object({
  body: z.object({
    status: z.string({ error: "Status is required!" }).trim().min(1).max(50),
    lost_reason: z.string().max(2000).optional(),
  }),
});

const createNote = z.object({
  body: z.object({
    note: z.string({ error: "Note is required!" }).trim().min(1).max(5000),
  }),
});

const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color must look like #2563eb!");

const createStatus = z.object({
  body: z.object({
    label_nl: z
      .string({ error: "Dutch label is required!" })
      .trim()
      .min(1)
      .max(100),
    label_en: z
      .string({ error: "English label is required!" })
      .trim()
      .min(1)
      .max(100),
    kind: z.enum(["OPEN", "WON", "LOST"], {
      error: "Kind should be OPEN, WON or LOST!",
    }),
    color: colorSchema.optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
  }),
});

const updateStatus = z.object({
  body: z.object({
    label_nl: z.string().trim().min(1).max(100).optional(),
    label_en: z.string().trim().min(1).max(100).optional(),
    color: colorSchema.optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    is_active: z.boolean().optional(),
  }),
});

export const InquiryValidation = {
  createInquiry,
  updateInquiry,
  changeStatus,
  createNote,
  createStatus,
  updateStatus,
};
