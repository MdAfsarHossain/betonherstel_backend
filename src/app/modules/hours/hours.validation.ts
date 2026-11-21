import z from "zod";
import { hasMaxDecimals } from "../../utils/money";
import { isValidDay } from "../../utils/dates";
import { entryTypes } from "./hours.interface";

const uuid = (label: string) =>
  z.string().uuid({ message: `Invalid ${label}!` });

const daySchema = z
  .string()
  .refine(isValidDay, { message: "Date must look like 2026-11-30!" });

const dateTime = z
  .string({ error: "A date and time with a time zone is required!" })
  .refine(
    (v) => /(Z|[+-]\d{2}:?\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)),
    {
      message: "Use ISO 8601 with a time zone, e.g. 2026-11-20T09:00:00+01:00!",
    },
  );

const typeSchema = z.enum(entryTypes, {
  error: "Type should be WORK, TRAVEL, INSPECTION or INTERNAL!",
});

const minutesSchema = z
  .number({ error: "Minutes must be a number!" })
  .int("Minutes must be a whole number!")
  .min(1, "At least 1 minute!")
  .max(1440, "At most 24 hours per entry!");

const noteSchema = z.string().trim().max(500).nullish();

// What an entry is booked on: a project or work order, or nothing for internal time
const targetRules = (b: {
  entry_type?: string;
  project_id?: string;
  work_order_id?: string;
}) =>
  (b.entry_type ?? "WORK") === "INTERNAL"
    ? !b.project_id && !b.work_order_id
    : !!(b.project_id || b.work_order_id);
const targetMessage = {
  message:
    "Internal time has no project or work order; all other hours need a project or a work order!",
  path: ["project_id"],
};

const createEntry = z.object({
  body: z
    .object({
      project_id: uuid("project id").optional(),
      work_order_id: uuid("work order id").optional(),
      work_date: daySchema.optional(),
      minutes: minutesSchema.optional(),
      started_at: dateTime.optional(),
      ended_at: dateTime.optional(),
      entry_type: typeSchema.optional(),
      is_billable: z.boolean().optional(),
      note: noteSchema,
      client_id: uuid("client id").optional(),
      user_id: uuid("user id").optional(),
    })
    .refine((b) => !!b.minutes !== (!!b.started_at || !!b.ended_at), {
      message: "Give the minutes, or a start and an end time (not both)!",
      path: ["minutes"],
    })
    .refine((b) => !!b.started_at === !!b.ended_at, {
      message: "A start time needs an end time, and the other way round!",
      path: ["ended_at"],
    })
    .refine(targetRules, targetMessage),
});

const updateEntry = z.object({
  body: z
    .object({
      work_date: daySchema.optional(),
      minutes: minutesSchema.optional(),
      entry_type: typeSchema.optional(),
      is_billable: z.boolean().optional(),
      note: noteSchema,
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});

const startTimer = z.object({
  body: z
    .object({
      project_id: uuid("project id").optional(),
      work_order_id: uuid("work order id").optional(),
      entry_type: typeSchema.optional(),
      is_billable: z.boolean().optional(),
      note: noteSchema,
    })
    .refine(targetRules, targetMessage),
});

const stopTimer = z.object({
  body: z.object({
    ended_at: dateTime.optional(),
    note: noteSchema,
  }),
});

const approve = z.object({
  body: z
    .object({
      entry_ids: z
        .array(uuid("entry id"))
        .min(1, "Pick at least one entry!")
        .max(500, "At most 500 entries at once!")
        .optional(),
      user_id: uuid("user id").optional(),
      week_start: daySchema.optional(),
    })
    .refine((b) => !!b.entry_ids !== (!!b.user_id || !!b.week_start), {
      message: "Give entry_ids, or an employee (user_id) with a week_start!",
      path: ["entry_ids"],
    })
    .refine((b) => !!b.user_id === !!b.week_start, {
      message: "An employee needs a week_start, and the other way round!",
      path: ["week_start"],
    }),
});

const reject = z.object({
  body: z.object({
    reason: z.string({ error: "A reason is required!" }).trim().min(3).max(500),
  }),
});

const unapprove = z.object({
  body: z.object({ reason: z.string().trim().max(500).optional() }),
});

const rate = (label: string) =>
  z
    .number({ error: `${label} must be a number!` })
    .min(0, `${label} cannot be negative!`)
    .max(10_000, `${label} is too high!`)
    .refine((v) => hasMaxDecimals(v, 2), {
      message: `${label} can have at most 2 decimals!`,
    });

const setRate = z.object({
  body: z.object({
    cost_rate: rate("Cost rate"),
    sales_rate: rate("Sales rate"),
    effective_from: daySchema.optional(),
  }),
});

export const HoursValidation = {
  createEntry,
  updateEntry,
  startTimer,
  stopTimer,
  approve,
  reject,
  unapprove,
  setRate,
};
