import z from "zod";
import { languageSchema, phoneSchema } from "../user/user.validation";

// Beheerder creates an internal user (FR-AUTH-01 / FR-AUTH-02)
const createUser = z.object({
  body: z.object({
    name: z.string({ error: "Name is required!" }).trim().min(1).max(255),
    email: z
      .string({ error: "Email is required!" })
      .email({ message: "Invalid email format!" }),
    password: z
      .string({ error: "Password is required!" })
      .min(8, "Password should be at least 8 characters"),
    phone_number: phoneSchema.optional(),
    role: z.enum(["ADMIN", "OFFICE", "FIELD"], {
      error: "Role should be one of ADMIN, OFFICE or FIELD!",
    }),
    preferred_language: languageSchema.optional(),
  }),
});

// Beheerder edits, deactivates or re-assigns the role of a user
const adminUpdateUser = z.object({
  body: z.object({
    name: z.string().trim().min(1, "Name cannot be empty!").max(255).optional(),
    phone_number: phoneSchema.optional(),
    address: z.string().max(500).optional(),
    role: z
      .enum(["ADMIN", "OFFICE", "FIELD"], {
        error: "Role should be one of ADMIN, OFFICE or FIELD!",
      })
      .optional(),
    status: z
      .enum(["ACTIVE", "INACTIVE", "BLOCKED"], {
        error: "Status should be one of ACTIVE, INACTIVE or BLOCKED!",
      })
      .optional(),
    is_active: z.boolean().optional(),
    preferred_language: languageSchema.optional(),
  }),
});

export const AdminValidation = {
  createUser,
  adminUpdateUser,
};
