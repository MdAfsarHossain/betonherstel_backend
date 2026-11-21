import z from "zod";
import { isValidDay } from "../../utils/dates";
import { hasMaxDecimals } from "../../utils/money";
import { addressSchema } from "../inquiry/inquiry.validation";
import { billingIntervals, visitsPerYearOptions } from "./contract.interface";

const uuid = (label: string) =>
  z.string().uuid({ message: `Invalid ${label}!` });
const daySchema = z
  .string()
  .refine(isValidDay, { message: "Date must look like 2026-11-30!" });
const languageSchema = z.enum(["NL", "EN"], {
  error: "Language should be either NL or EN!",
});
const intervalSchema = z.enum(billingIntervals, {
  error: "Billing interval should be MONTHLY, QUARTERLY or YEARLY!",
});

const amount = z
  .number({ error: "The amount must be a number!" })
  .gt(0, "The amount must be greater than 0!")
  .max(10_000_000, "The amount is too high!")
  .refine((v) => hasMaxDecimals(v, 2), {
    message: "The amount can have at most 2 decimals!",
  });

const visitsPerYear = z
  .number({ error: "Visits per year must be a number!" })
  .refine((v) => (visitsPerYearOptions as readonly number[]).includes(v), {
    message: "Visits per year should be 0, 1, 2, 3, 4, 6 or 12!",
  });

const fields = {
  title: z
    .string({ error: "Title is required!" })
    .trim()
    .min(1, "Title is required!")
    .max(255),
  description: z.string().trim().max(5000).nullish(),
  address: addressSchema.nullish(),
  amount_excl_vat: amount,
  vat_code: z.string().trim().min(1).max(20),
  billing_interval: intervalSchema,
  end_date: daySchema.nullish(),
  payment_term_days: z.number().int().min(0).max(120),
  use_direct_debit: z.boolean(),
  language: languageSchema,
  visits_per_year: visitsPerYear,
  first_visit_date: daySchema.nullish(),
  visit_assignee_ids: z.array(uuid("user id")).max(20),
  internal_notes: z.string().trim().max(5000).nullish(),
};

const createContract = z.object({
  body: z.object({
    relation_id: uuid("relation id"),
    title: fields.title,
    description: fields.description,
    address: fields.address,
    amount_excl_vat: fields.amount_excl_vat,
    vat_code: fields.vat_code.optional(),
    billing_interval: fields.billing_interval,
    start_date: daySchema,
    end_date: fields.end_date,
    payment_term_days: fields.payment_term_days.optional(),
    use_direct_debit: fields.use_direct_debit.optional(),
    language: fields.language.optional(),
    visits_per_year: fields.visits_per_year.optional(),
    first_visit_date: fields.first_visit_date,
    visit_assignee_ids: fields.visit_assignee_ids.optional(),
    internal_notes: fields.internal_notes,
  }),
});

const updateContract = z.object({
  body: z
    .object({
      title: fields.title.optional(),
      description: fields.description,
      address: fields.address,
      amount_excl_vat: fields.amount_excl_vat.optional(),
      vat_code: fields.vat_code.optional(),
      billing_interval: fields.billing_interval.optional(),
      end_date: fields.end_date,
      payment_term_days: fields.payment_term_days.optional(),
      use_direct_debit: fields.use_direct_debit.optional(),
      language: fields.language.optional(),
      visits_per_year: fields.visits_per_year.optional(),
      first_visit_date: fields.first_visit_date,
      visit_assignee_ids: fields.visit_assignee_ids.optional(),
      internal_notes: fields.internal_notes,
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});

const endContract = z.object({
  body: z.object({
    end_date: daySchema.optional(),
    reason: z.string().trim().max(2000).nullish(),
  }),
});

const startDirectDebit = z.object({
  body: z.object({
    // Email the customer the authorisation link
    send_email: z.boolean().optional(),
  }),
});

const runJobs = z.object({
  body: z.object({
    // Bill just this contract (when it is due)
    subscription_id: uuid("subscription id").optional(),
  }),
});

export const ContractValidation = {
  createContract,
  updateContract,
  endContract,
  startDirectDebit,
  runJobs,
};
