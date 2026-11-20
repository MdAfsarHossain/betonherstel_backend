import z from "zod";
import { hasMaxDecimals } from "../../utils/money";
import { isValidDay } from "../../utils/dates";
import { addressSchema } from "../inquiry/inquiry.validation";
import { responseChannels } from "./subcontracting.interface";

const uuid = (label: string) => z.string().uuid({ message: `Invalid ${label}!` });

const daySchema = z.string().refine(isValidDay, { message: "Date must look like 2026-11-30!" });

const optionalEmail = z
  .string()
  .email({ message: "Invalid email format!" })
  .max(255)
  .or(z.literal(""))
  .nullish();

const languageSchema = z.enum(["NL", "EN"], { error: "Language should be either NL or EN!" });

const channelSchema = z.enum(responseChannels, { error: "Via should be PHONE, EMAIL, IN_PERSON, OTHER or PORTAL!" });

const price = z
  .number({ error: "The agreed price must be a number!" })
  .gt(0, "The agreed price must be greater than 0!")
  .max(100_000_000, "The agreed price is too high!")
  .refine((v) => hasMaxDecimals(v, 2), { message: "The agreed price can have at most 2 decimals!" });

const money = z
  .number({ error: "Amount must be a number!" })
  .min(-100_000_000)
  .max(100_000_000)
  .refine((v) => hasMaxDecimals(v, 2), { message: "At most 2 decimals!" });

const vatCode = z.string().regex(/^[A-Z0-9_-]{1,20}$/, "Invalid VAT code!");

const datesInOrder = (b: { planned_start?: string | null; planned_end?: string | null }) =>
  !b.planned_start || !b.planned_end || b.planned_end >= b.planned_start;
const datesMessage = { message: "The end date cannot be before the start date!", path: ["planned_end"] };

const createAssignment = z.object({
  body: z
    .object({
      project_id: uuid("project id"),
      subcontractor_id: uuid("subcontractor id"),
      title: z.string().trim().min(1, "The title is required!").max(255),
      scope_description: z.string().trim().min(1, "Describe the work!").max(10000),
      agreed_price_excl_vat: price,
      vat_code: vatCode.optional(),
      planned_start: daySchema.nullish(),
      planned_end: daySchema.nullish(),
      work_address: addressSchema.nullish(),
      language: languageSchema.optional(),
      recipient_name: z.string().max(255).nullish(),
      recipient_email: optionalEmail,
      internal_notes: z.string().max(5000).nullish(),
    })
    .refine(datesInOrder, datesMessage),
});

const updateAssignment = z.object({
  body: z
    .object({
      title: z.string().trim().min(1).max(255).optional(),
      scope_description: z.string().trim().min(1).max(10000).optional(),
      agreed_price_excl_vat: price.optional(),
      vat_code: vatCode.optional(),
      planned_start: daySchema.nullish(),
      planned_end: daySchema.nullish(),
      work_address: addressSchema.nullish(),
      language: languageSchema.optional(),
      recipient_name: z.string().max(255).nullish(),
      recipient_email: optionalEmail,
      internal_notes: z.string().max(5000).nullish(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: "No fields to update" })
    .refine(datesInOrder, datesMessage),
});

const sendAssignment = z.object({
  body: z.object({ email: z.string().email({ message: "Invalid email format!" }).max(255).optional() }),
});

const respondAssignment = z.object({
  body: z
    .object({
      response: z.enum(["CONFIRM", "DECLINE"], { error: "Response should be CONFIRM or DECLINE!" }),
      via: channelSchema.optional(),
      comment: z.string().trim().max(5000).nullish(),
      proposed_start: daySchema.nullish(),
      proposed_end: daySchema.nullish(),
    })
    .refine((b) => b.response === "DECLINE" || (!b.proposed_start && !b.proposed_end), {
      message: "Proposed dates can only be given with a decline!",
      path: ["proposed_start"],
    })
    .refine((b) => !b.proposed_start || !b.proposed_end || b.proposed_end >= b.proposed_start, {
      message: "The proposed end date cannot be before the start date!",
      path: ["proposed_end"],
    }),
});

const reportProgress = z.object({
  body: z.object({
    percent: z
      .number({ error: "Percent must be a number!" })
      .int("Percent must be a whole number!")
      .min(0, "Percent cannot be below 0!")
      .max(100, "Percent cannot be above 100!"),
    note: z.string().trim().max(5000).nullish(),
    via: channelSchema.optional(),
  }),
});

const completeAssignment = z.object({
  body: z.object({ note: z.string().trim().max(5000).nullish() }),
});

const cancelAssignment = z.object({
  body: z.object({ reason: z.string({ error: "A reason is required!" }).trim().min(1, "A reason is required!").max(2000) }),
});

const reopenAssignment = z.object({
  body: z.object({ reason: z.string().trim().max(2000).nullish() }),
});

const recordInvoice = z.object({
  body: z.object({
    invoice_number: z.string({ error: "The invoice number is required!" }).trim().min(1).max(60),
    invoice_date: daySchema,
    due_date: daySchema.nullish(),
    amount_excl_vat: money,
    vat_amount: money,
    amount_incl_vat: money,
    vat_code: vatCode.nullish(),
    description: z.string().max(5000).nullish(),
    internal_notes: z.string().max(5000).nullish(),
  }),
});

export const SubcontractingValidation = {
  createAssignment,
  updateAssignment,
  sendAssignment,
  respondAssignment,
  reportProgress,
  completeAssignment,
  cancelAssignment,
  reopenAssignment,
  recordInvoice,
};
