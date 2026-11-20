import z from "zod";
import { hasMaxDecimals } from "../../utils/money";
import { isValidDay } from "../../utils/dates";
import { units } from "../../utils/units";
import { addressSchema } from "../inquiry/inquiry.validation";
import { projectFolders } from "./project.interface";

const uuid = (label: string) => z.string().uuid({ message: `Invalid ${label}!` });

const daySchema = z
  .string()
  .refine(isValidDay, { message: "Date must look like 2026-11-30!" });

const optionalEmail = z
  .string()
  .email({ message: "Invalid email format!" })
  .max(255)
  .or(z.literal(""))
  .nullish();

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must look like #2563eb!");

// Same line format as a quotation: with a catalogue item, description / unit / prices default from the catalogue
const lineSchema = z
  .object({
    catalogue_item_id: uuid("catalogue item id").optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    quantity: z
      .number({ error: "Quantity must be a number!" })
      .gt(0, "Quantity must be greater than 0!")
      .max(1_000_000, "Quantity is too high!")
      .refine((v) => hasMaxDecimals(v, 3), { message: "Quantity can have at most 3 decimals!" }),
    unit: z.enum(units, { error: "Unit should be one of m, m2, m3, piece, hour or lump_sum!" }).optional(),
    unit_price: z
      .number({ error: "Unit price must be a number!" })
      .min(-10_000_000)
      .max(10_000_000)
      .refine((v) => hasMaxDecimals(v, 2), { message: "Unit price can have at most 2 decimals!" })
      .optional(),
    cost_price: z
      .number({ error: "Cost price must be a number!" })
      .min(0, "Cost price cannot be negative!")
      .max(10_000_000)
      .refine((v) => hasMaxDecimals(v, 2), { message: "Cost price can have at most 2 decimals!" })
      .optional(),
    vat_code: z.string().regex(/^[A-Z0-9_-]{1,20}$/, "Invalid VAT code!").optional(),
  })
  .refine(
    (l) => l.catalogue_item_id || (l.description && l.unit && l.unit_price !== undefined),
    { message: "A line needs a catalogue item, or a description, unit and unit price!", path: ["description"] },
  );

const sectionsSchema = z
  .array(
    z.object({
      title: z.string().trim().max(255).nullish(),
      lines: z.array(lineSchema).min(1, "A section needs at least one line!").max(200),
    }),
  )
  .max(30, "At most 30 sections!")
  .refine((sections) => sections.reduce((n, s) => n + s.lines.length, 0) <= 500, {
    message: "At most 500 lines per project!",
  });

const headerFields = {
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(10000).nullish(),
  service_type: z.string().max(50).nullish(),
  address: addressSchema.nullish(),
  planned_start: daySchema.nullish(),
  planned_end: daySchema.nullish(),
  contact_name: z.string().max(255).nullish(),
  contact_email: optionalEmail,
  contact_phone: z.string().max(50).nullish(),
  project_manager_id: uuid("user id").nullish(),
  internal_notes: z.string().max(5000).nullish(),
};

const datesInOrder = (b: { planned_start?: string | null; planned_end?: string | null }) =>
  !b.planned_start || !b.planned_end || b.planned_end >= b.planned_start;
const datesMessage = { message: "The end date cannot be before the start date!", path: ["planned_end"] };

const createProject = z.object({
  body: z
    .object({
      quote_id: uuid("quote id").optional(),
      relation_id: uuid("relation id").optional(),
      ...headerFields,
      sections: sectionsSchema.optional(),
    })
    .refine((b) => b.quote_id || b.relation_id, {
      message: "Provide a quote_id (accepted quotation) or a relation_id!",
      path: ["quote_id"],
    })
    .refine((b) => !(b.quote_id && b.sections), {
      message: "A project from a quotation takes its budget from the quotation!",
      path: ["sections"],
    })
    .refine((b) => b.quote_id || b.title, { message: "Title is required!", path: ["title"] })
    .refine(datesInOrder, datesMessage),
});

const updateProject = z.object({
  body: z.object(headerFields).refine(datesInOrder, datesMessage),
});

const changeStatus = z.object({
  body: z.object({
    status: z.string({ error: "Status is required!" }).trim().min(1).max(50),
    note: z.string().max(2000).nullish(),
  }),
});

const setBudget = z.object({
  body: z.object({ sections: sectionsSchema }),
});

const additionalLine = z
  .object({
    section_title: z.string().trim().max(255).nullish(),
    catalogue_item_id: uuid("catalogue item id").optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    quantity: z
      .number({ error: "Quantity must be a number!" })
      .gt(0, "Quantity must be greater than 0!")
      .max(1_000_000, "Quantity is too high!")
      .refine((v) => hasMaxDecimals(v, 3), { message: "Quantity can have at most 3 decimals!" }),
    unit: z.enum(units).optional(),
    unit_price: z
      .number()
      .min(-10_000_000)
      .max(10_000_000)
      .refine((v) => hasMaxDecimals(v, 2), { message: "Unit price can have at most 2 decimals!" })
      .optional(),
    cost_price: z
      .number()
      .min(0)
      .max(10_000_000)
      .refine((v) => hasMaxDecimals(v, 2), { message: "Cost price can have at most 2 decimals!" })
      .optional(),
    vat_code: z.string().regex(/^[A-Z0-9_-]{1,20}$/, "Invalid VAT code!").optional(),
  })
  .refine(
    (l) => l.catalogue_item_id || (l.description && l.unit && l.unit_price !== undefined),
    { message: "A line needs a catalogue item, or a description, unit and unit price!", path: ["description"] },
  );

const addAdditionalWork = z.object({ body: additionalLine });

const updateAdditionalWork = z.object({
  body: z
    .object({
      section_title: z.string().trim().max(255).nullish(),
      description: z.string().trim().min(1).max(2000).optional(),
      quantity: z
        .number()
        .gt(0)
        .max(1_000_000)
        .refine((v) => hasMaxDecimals(v, 3), { message: "Quantity can have at most 3 decimals!" })
        .optional(),
      unit: z.enum(units).optional(),
      unit_price: z
        .number()
        .min(-10_000_000)
        .max(10_000_000)
        .refine((v) => hasMaxDecimals(v, 2), { message: "Unit price can have at most 2 decimals!" })
        .optional(),
      cost_price: z
        .number()
        .min(0)
        .max(10_000_000)
        .refine((v) => hasMaxDecimals(v, 2), { message: "Cost price can have at most 2 decimals!" })
        .optional(),
      vat_code: z.string().regex(/^[A-Z0-9_-]{1,20}$/, "Invalid VAT code!").optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: "No fields to update" }),
});

const updateFile = z.object({
  body: z
    .object({
      folder: z.enum(projectFolders, { error: "Folder should be BEFORE, DURING, AFTER or GENERAL!" }).optional(),
      caption: z.string().trim().max(255).nullish(),
      share_with_customer: z.boolean().optional(),
      share_with_subcontractor: z.boolean().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: "No fields to update" }),
});

const createStatus = z.object({
  body: z.object({
    label_nl: z.string({ error: "Dutch label is required!" }).trim().min(1).max(100),
    label_en: z.string({ error: "English label is required!" }).trim().min(1).max(100),
    kind: z.enum(["OPEN", "CLOSED"], { error: "Kind should be OPEN or CLOSED!" }),
    color: colorSchema.optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
  }),
});

const updateStatus = z.object({
  body: z.object({
    label_nl: z.string().trim().min(1).max(100).optional(),
    label_en: z.string().trim().min(1).max(100).optional(),
    color: colorSchema.optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    is_active: z.boolean().optional(),
  }),
});

export const ProjectValidation = {
  createProject,
  updateProject,
  changeStatus,
  setBudget,
  addAdditionalWork,
  updateAdditionalWork,
  updateFile,
  createStatus,
  updateStatus,
};
