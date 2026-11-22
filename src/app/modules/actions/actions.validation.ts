import z from "zod";
import { isValidDay } from "../../utils/dates";
import { actionEntityTypes } from "./actions.interface";

const uuid = (label: string) =>
  z.string().uuid({ message: `Invalid ${label}!` });

const daySchema = z
  .string()
  .refine(isValidDay, { message: "Date must look like 2026-11-30!" });

const entitySchema = z.object(
  {
    type: z.enum(actionEntityTypes, {
      error:
        "Type should be relation, inquiry, quote, project, appointment, work_order, invoice, purchase_order, supplier_invoice or subcontract_assignment!",
    }),
    id: uuid("record id"),
  },
  { error: "The linked record needs a type and an id!" },
);

const createAction = z.object({
  body: z.object({
    title: z
      .string({ error: "The title is required!" })
      .trim()
      .min(1, "The title is required!")
      .max(255),
    description: z.string().trim().max(5000).nullish(),
    due_date: daySchema.nullish(),
    assignee_id: uuid("assignee id").nullish(),
    entity: entitySchema.nullish(),
  }),
});

const updateAction = z.object({
  body: z
    .object({
      title: z.string().trim().min(1).max(255).optional(),
      description: z.string().trim().max(5000).nullish(),
      due_date: daySchema.nullish(),
      assignee_id: uuid("assignee id").nullish(),
      entity: entitySchema.nullish(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});

const completeAction = z.object({
  body: z.object({ note: z.string().trim().max(2000).nullish() }),
});

export const ActionValidation = { createAction, updateAction, completeAction };
