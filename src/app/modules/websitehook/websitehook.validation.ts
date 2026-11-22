import { z } from "zod";
import { crmFields } from "./websitehook.interface";

// An incoming key may be nested: "customer.email"
const incomingKey = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9_\-. ]+$/,
    "A key can only contain letters, digits, spaces, _ - and .",
  )
  .refine(
    (k) =>
      !k
        .split(".")
        .some((p) => ["__proto__", "constructor", "prototype"].includes(p)),
    "Invalid key!",
  );

const mapping = z
  .record(
    incomingKey,
    z.enum(crmFields, { error: `Map to one of: ${crmFields.join(", ")}` }),
  )
  .refine((m) => Object.keys(m).length <= 50, {
    message: "At most 50 mappings!",
  });

const updateSettings = z.object({
  body: z
    .object({
      mapping: mapping.optional(),
      default_language: z
        .enum(["NL", "EN"], { error: "Language should be NL or EN!" })
        .optional(),
      is_active: z.boolean().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});

const testMapping = z.object({
  body: z.object({
    payload: z.record(z.string(), z.any(), {
      error: "Send a sample payload object!",
    }),
  }),
});

export const WebsiteHookValidation = { updateSettings, testMapping };
