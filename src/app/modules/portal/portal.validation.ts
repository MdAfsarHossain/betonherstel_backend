import z from "zod";
import { isValidDay } from "../../utils/dates";
import { addressSchema } from "../inquiry/inquiry.validation";

const uuid = (label: string) =>
  z.string().uuid({ message: `Invalid ${label}!` });
const languageSchema = z.enum(["NL", "EN"], {
  error: "Language should be either NL or EN!",
});
const phoneRegex = /^[+]?[0-9 ()-]{6,20}$/;
const phone = z.string().regex(phoneRegex, {
  message: "Phone number is not valid. Please enter a valid phone number.",
});
const message = z
  .string({ error: "The message cannot be empty!" })
  .trim()
  .min(1, "The message cannot be empty!")
  .max(5000, "The message is too long!");

// ---- Office: managing portal users (FR-PORT-01, FR-PORT-11)

const inviteUser = z.object({
  body: z
    .object({
      relation_id: uuid("relation id"),
      contact_id: uuid("contact id").optional(),
      name: z.string().trim().min(1).max(255).optional(),
      email: z
        .string()
        .email({ message: "Invalid email format!" })
        .max(255)
        .optional(),
      phone_number: phone.optional(),
      language: languageSchema.optional(),
    })
    .refine((b) => b.contact_id || (b.name && b.email), {
      message: "Give a contact_id, or a name and an email address!",
      path: ["email"],
    }),
});

const updateUser = z.object({
  body: z
    .object({
      is_active: z.boolean().optional(),
      name: z.string().trim().min(1).max(255).optional(),
      phone_number: phone.nullish(),
      language: languageSchema.optional(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});


// ---- Customer: acting in the portal

const acceptQuote = z.object({
  body: z.object({
    terms_accepted: z.literal(true, {
      error: "You must agree to the terms and conditions to accept!",
    }),
    accepted_by_name: z
      .string()
      .trim()
      .min(2, "Enter your full name!")
      .max(255)
      .optional(),
  }),
});

const rejectQuote = z.object({
  body: z.object({ reason: z.string().trim().max(2000).nullish() }),
});

const updateMe = z.object({
  body: z
    .object({
      name: z.string().trim().min(1).max(255).optional(),
      phone_number: phone.nullish(),
      preferred_language: languageSchema.optional(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});

const createInquiry = z.object({
  body: z.object({
    description: z
      .string({ error: "Describe what you need!" })
      .trim()
      .min(5, "Describe what you need!")
      .max(5000),
    service_type: z.string().max(50).nullish(),
    address: addressSchema.nullish(),
    contact_phone: phone.optional(),
  }),
});

const updateInquiry = z.object({
  body: z
    .object({
      description: z.string().trim().min(5, "Describe what you need!").max(5000).optional(),
      service_type: z.string().max(50).nullish(),
      address: addressSchema.nullish(),
      contact_phone: phone.nullish(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: "No fields to update" }),
});

export const PortalValidation = {
  inviteUser,
  updateUser,
  acceptQuote,
  rejectQuote,
  updateMe,
  createInquiry,
  updateInquiry,
  isValidDay,
};
