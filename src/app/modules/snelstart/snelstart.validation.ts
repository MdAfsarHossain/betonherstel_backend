import z from "zod";
import { isValidDay } from "../../utils/dates";
import {
  ledgerKinds,
  lineBtwSoorten,
  purchaseBtwRegelSoorten,
  salesBtwRegelSoorten,
} from "./snelstart.interface";

const daySchema = z
  .string()
  .refine(isValidDay, { message: "Date must look like 2026-11-30!" });

const connect = z.object({
  body: z.object({
    // The connection key (maatwerksleutel) the accountant generates in SnelStart
    connection_key: z
      .string({ error: "The connection key is required!" })
      .trim()
      .min(8, "That does not look like a connection key!")
      .max(512)
      .refine((v) => !/\s/.test(v), {
        message: "A connection key has no spaces!",
      }),
    // The integration's subscription key from the SnelStart developer portal. Optional when the server has it set.
    subscription_key: z
      .string()
      .trim()
      .min(8)
      .max(200)
      .refine((v) => !/\s/.test(v), {
        message: "A subscription key has no spaces!",
      })
      .optional(),
  }),
});

const updateSettings = z.object({
  body: z
    .object({
      is_enabled: z
        .boolean({ error: "is_enabled must be true or false!" })
        .optional(),
      sync_interval_minutes: z
        .number()
        .int("Whole minutes only!")
        .min(1, "At least 1 minute!")
        .max(1440, "At most 1440 minutes (a day)!")
        .optional(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});

const vatMapping = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          vat_code: z.string().trim().min(1).max(20),
          line_btw_soort: z.enum(lineBtwSoorten, {
            error: `line_btw_soort should be one of ${lineBtwSoorten.join(", ")}!`,
          }),
          sales_btw_regel_soort: z.enum(salesBtwRegelSoorten, {
            error: `sales_btw_regel_soort should be one of ${salesBtwRegelSoorten.join(", ")}!`,
          }),
          purchase_btw_regel_soort: z.enum(purchaseBtwRegelSoorten, {
            error: `purchase_btw_regel_soort should be one of ${purchaseBtwRegelSoorten.join(", ")}!`,
          }),
        }),
      )
      .min(1, "Send at least one VAT code!")
      .max(20),
  }),
});

const ledgerMapping = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          kind: z.enum(ledgerKinds, {
            error: "kind should be REVENUE or COST!",
          }),
          vat_code: z.string().trim().min(1).max(20),
          // Optional: a category (service type) with its own revenue account
          service_type: z.string().trim().min(1).max(50).nullish(),
          grootboek_id: z
            .string({ error: "The SnelStart ledger account id is required!" })
            .trim()
            .min(1)
            .max(64),
        }),
      )
      .min(1, "Send at least one mapping!")
      .max(50),
  }),
});

const skip = z.object({
  body: z.object({
    reason: z.string({ error: "A reason is required!" }).trim().min(3).max(500),
  }),
});
const backfill = z.object({
  body: z.object({ from: daySchema, to: daySchema.optional() }),
});

export const SnelStartValidation = {
  connect,
  updateSettings,
  vatMapping,
  ledgerMapping,
  skip,
  backfill,
};
