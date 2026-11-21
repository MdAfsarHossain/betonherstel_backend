import z from "zod";

const text = (max: number) => z.string().trim().max(max).optional();

// The body of the public website form. JSON or multipart/form-data (with photos).
// Everything except the name and a way to reach the person is optional, so a lead is never
// lost for a small detail: an address that is not complete is kept as a line in the description.
const createInquiry = z.object({
  body: z
    .object({
      contact_name: z
        .string({ error: "Name is required!" })
        .trim()
        .min(1, "Name is required!")
        .max(255),
      contact_email: z
        .string()
        .trim()
        .email({ message: "Invalid email format!" })
        .max(255)
        .or(z.literal(""))
        .optional(),
      contact_phone: z
        .string()
        .trim()
        .regex(/^[+]?[0-9 ()-]{6,20}$/, {
          message: "Phone number is not valid!",
        })
        .or(z.literal(""))
        .optional(),
      company_name: text(255),
      service_type: text(50),
      description: text(5000),
      // The address as one object (JSON) or, for a plain/multipart form, as the separate fields below
      address: z.any().optional(),
      street: text(255),
      house_number: text(20),
      postcode: text(12),
      city: text(100),
      language: z
        .enum(["NL", "EN"], { error: "Language should be either NL or EN!" })
        .optional(),
      // Stops a double click or a retry from making two inquiries (8-64 characters)
      submission_id: z.string().trim().min(8).max(64).optional(),
      // Honeypot: a hidden field real visitors never fill in
      website: z.string().max(500).optional(),
    })
    .refine((b) => b.contact_email || b.contact_phone, {
      message: "An email or phone number is required!",
      path: ["contact_email"],
    }),
});

export const PublicInquiryValidation = { createInquiry };
