import z from "zod";
import { hasMaxDecimals } from "../../utils/money";
import { isValidDay } from "../../utils/dates";
import { units } from "../../utils/units";
import { addressSchema } from "../inquiry/inquiry.validation";
import { hourTypes } from "./workorder.interface";

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

const quantity = (label: string) =>
  z
    .number({ error: `${label} must be a number!` })
    .min(0, `${label} cannot be negative!`)
    .max(1_000_000, `${label} is too high!`)
    .refine((v) => hasMaxDecimals(v, 3), {
      message: `${label} can have at most 3 decimals!`,
    });

const checklistItem = z.object({
  id: uuid("checklist item id").optional(),
  text: z.string({ error: "Text is required!" }).trim().min(1).max(500),
  is_required: z.boolean().optional(),
});

const checklistSchema = z
  .array(checklistItem)
  .max(100, "At most 100 checklist items!");

const materialItem = z
  .object({
    id: uuid("material id").optional(),
    catalogue_item_id: uuid("catalogue item id").optional(),
    description: z.string().trim().min(1).max(500).optional(),
    unit: z
      .enum(units, {
        error: "Unit should be one of m, m2, m3, piece, hour or lump_sum!",
      })
      .optional(),
    quantity_planned: quantity("Quantity"),
    note: z.string().trim().max(500).nullish(),
  })
  .refine((m) => m.catalogue_item_id || (m.description && m.unit), {
    message: "A material needs a catalogue item, or a description and unit!",
    path: ["description"],
  });

const materialsSchema = z
  .array(materialItem)
  .max(200, "At most 200 materials!");

const assigneeIds = z.array(uuid("user id")).max(20, "At most 20 employees!");

const hourFields = {
  work_date: daySchema,
  minutes: z
    .number({ error: "Minutes must be a number!" })
    .int("Minutes must be a whole number!")
    .min(1, "At least 1 minute!")
    .max(1440, "At most 24 hours per entry!"),
  entry_type: z
    .enum(hourTypes, { error: "Type should be WORK or TRAVEL!" })
    .optional(),
  is_billable: z.boolean().optional(),
  note: z.string().trim().max(500).nullish(),
};

const createWorkOrder = z.object({
  body: z.object({
    project_id: uuid("project id"),
    appointment_id: uuid("appointment id").optional(),
    title: z.string().trim().min(1).max(255).optional(),
    instructions: z.string().max(10000).nullish(),
    planned_date: daySchema.nullish(),
    address: addressSchema.nullish(),
    internal_notes: z.string().max(5000).nullish(),
    assignee_ids: assigneeIds.optional(),
    checklist: checklistSchema.optional(),
    materials: materialsSchema.optional(),
  }),
});

const updateWorkOrder = z.object({
  body: z.object({
    title: z.string().trim().min(1).max(255).optional(),
    instructions: z.string().max(10000).nullish(),
    planned_date: daySchema.nullish(),
    address: addressSchema.nullish(),
    internal_notes: z.string().max(5000).nullish(),
    assignee_ids: assigneeIds.optional(),
  }),
});

const setChecklist = z.object({ body: z.object({ items: checklistSchema }) });
const setMaterials = z.object({ body: z.object({ items: materialsSchema }) });

const signatureField = z
  .string({ error: "The signature is required!" })
  .max(700_000, "The signature image is too large!");

const sync = z.object({
  body: z
    .object({
      work_performed: z.string().max(10000).nullish(),
      notes: z.string().max(5000).nullish(),
      checklist: z
        .array(
          z.object({
            id: uuid("checklist item id"),
            is_done: z.boolean(),
            done_at: dateTime.optional(),
          }),
        )
        .max(100)
        .optional(),
      materials: z
        .array(
          z.object({
            id: uuid("material id"),
            quantity_used: quantity("Quantity").nullable(),
          }),
        )
        .max(200)
        .optional(),
      extra_materials: z
        .array(
          z.object({
            client_id: uuid("client id"),
            description: z.string().trim().min(1).max(500),
            unit: z.enum(units),
            quantity_used: quantity("Quantity"),
            note: z.string().trim().max(500).nullish(),
          }),
        )
        .max(50)
        .optional(),
      hours: z
        .array(z.object({ client_id: uuid("client id"), ...hourFields }))
        .max(50)
        .optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: "Nothing to save" }),
});

const addHours = z.object({
  body: z.object({
    client_id: uuid("client id").optional(),
    user_id: uuid("user id").optional(),
    ...hourFields,
  }),
});

const updateHours = z.object({
  body: z
    .object({
      work_date: daySchema.optional(),
      minutes: hourFields.minutes.optional(),
      entry_type: hourFields.entry_type,
      is_billable: z.boolean().optional(),
      note: z.string().trim().max(500).nullish(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});

const signature = z.object({
  body: z.object({
    signed_by_name: z
      .string({ error: "The name of who signed is required!" })
      .trim()
      .min(2)
      .max(255),
    signature: signatureField,
  }),
});

const complete = z.object({
  body: z
    .object({
      work_performed: z.string().max(10000).nullish(),
      signed_by_name: z.string().trim().min(2).max(255).optional(),
      signature: signatureField.optional(),
    })
    .refine((b) => !b.signature || b.signed_by_name, {
      message: "The name of who signed is required with a signature!",
      path: ["signed_by_name"],
    }),
});

const reopen = z.object({
  body: z.object({
    reason: z
      .string({ error: "A reason is required!" })
      .trim()
      .min(3)
      .max(1000),
  }),
});

const send = z.object({
  body: z.object({
    email: z
      .string()
      .email({ message: "Invalid email format!" })
      .max(255)
      .optional(),
  }),
});

export const WorkOrderValidation = {
  createWorkOrder,
  updateWorkOrder,
  setChecklist,
  setMaterials,
  sync,
  addHours,
  updateHours,
  signature,
  complete,
  reopen,
  send,
};
