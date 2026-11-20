import z from "zod";

const phoneRegex =
  /^[+]*[0-9]{1,4}[ -]?[0-9]{1,4}[ -]?[0-9]{1,4}[ -]?[0-9]{1,4}$/;

export const phoneSchema = z
  .string()
  .regex(phoneRegex, {
    message: "Phone number is not valid. Please enter a valid phone number.",
  });

export const languageSchema = z.enum(["NL", "EN"], {
  error: "Language should be either NL or EN!",
});

// Self profile update. Privileged fields (role, status, is_active) are
// deliberately absent and are also ignored by the service.
const updateUser = z.object({
  body: z.object({
    name: z.string().trim().min(1, "Name cannot be empty!").max(255).optional(),
    phone_number: phoneSchema.optional(),
    email: z.string().email({ message: "Invalid email format!" }).optional(),
    address: z.string().max(500).optional(),
    date_of_birth: z.string().max(50).optional(),
    preferred_language: languageSchema.optional(),
  }),
});

export const UserValidation = {
  updateUser,
};
