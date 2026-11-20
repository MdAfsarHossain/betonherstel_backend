import z from "zod";
import { addressSchema } from "../inquiry/inquiry.validation";
import { appointmentStatuses, appointmentTypes } from "./planning.interface";

const uuid = (label: string) =>
  z.string().uuid({ message: `Invalid ${label}!` });

// Appointments are moments in time, so a time zone is required: 2026-11-20T09:00:00+01:00 or ...Z
const dateTime = z
  .string()
  .refine(
    (v) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(
        v,
      ) && !Number.isNaN(Date.parse(v)),
    {
      message:
        "Date and time must look like 2026-11-20T09:00:00+01:00 (with a time zone)!",
    },
  );

const assigneeIds = z
  .array(uuid("user id"))
  .max(20, "At most 20 employees per appointment!");

const typeSchema = z.enum(appointmentTypes, {
  error:
    "Type should be one of INSPECTION, PROJECT_WORK, MAINTENANCE or INTERNAL!",
});

const createAppointment = z.object({
  body: z
    .object({
      type: typeSchema,
      title: z.string().trim().min(1).max(255).optional(),
      starts_at: dateTime,
      ends_at: dateTime,
      all_day: z.boolean().optional(),
      relation_id: uuid("relation id").optional(),
      inquiry_id: uuid("inquiry id").optional(),
      project_id: uuid("project id").optional(),
      address: addressSchema.nullish(),
      notes: z.string().max(5000).nullish(),
      assignee_ids: assigneeIds.optional(),
      send_confirmation: z.boolean().optional(),
    })
    .refine((b) => Date.parse(b.ends_at) > Date.parse(b.starts_at), {
      message: "The end must be after the start!",
      path: ["ends_at"],
    })
    .refine(
      (b) =>
        Date.parse(b.ends_at) - Date.parse(b.starts_at) <= 366 * 86_400_000,
      {
        message: "An appointment can last at most 366 days!",
        path: ["ends_at"],
      },
    ),
});

// Drag and drop sends only the new times; the service checks them against the stored ones
const updateAppointment = z.object({
  body: z.object({
    type: typeSchema.optional(),
    title: z.string().trim().min(1).max(255).optional(),
    starts_at: dateTime.optional(),
    ends_at: dateTime.optional(),
    all_day: z.boolean().optional(),
    project_id: uuid("project id").nullable().optional(),
    address: addressSchema.nullish(),
    notes: z.string().max(5000).nullish(),
    assignee_ids: assigneeIds.optional(),
  }),
});

const changeStatus = z.object({
  body: z.object({
    status: z.enum(appointmentStatuses, {
      error: "Status should be PLANNED, COMPLETED or CANCELLED!",
    }),
    reason: z.string().trim().max(1000).optional(),
  }),
});

// The crew marks their own appointment as done, with an optional short note for the office
// (a phone may send the tap with no body at all)
const completeMine = z.object({
  body: z
    .object({
      note: z.string().trim().max(1000).optional(),
    })
    .optional(),
});

const checkConflicts = z.object({
  body: z
    .object({
      assignee_ids: assigneeIds.min(1, "Pick at least one employee!"),
      starts_at: dateTime,
      ends_at: dateTime,
      exclude_appointment_id: uuid("appointment id").optional(),
    })
    .refine((b) => Date.parse(b.ends_at) > Date.parse(b.starts_at), {
      message: "The end must be after the start!",
      path: ["ends_at"],
    }),
});

const sendConfirmation = z.object({
  body: z.object({
    email: z
      .string()
      .email({ message: "Invalid email format!" })
      .max(255)
      .optional(),
  }),
});

export const PlanningValidation = {
  createAppointment,
  updateAppointment,
  changeStatus,
  completeMine,
  checkConflicts,
  sendConfirmation,
};
