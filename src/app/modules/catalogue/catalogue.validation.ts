import z from "zod";
import { hasMaxDecimals } from "../../utils/money";
import { units } from "../../utils/units";
import { catalogueItemTypes } from "./catalogue.interface";

const price = (label: string) =>
  z
    .number({ error: `${label} must be a number!` })
    .min(0, `${label} cannot be negative!`)
    .max(10_000_000, `${label} is too high!`)
    .refine((v) => hasMaxDecimals(v, 2), { message: `${label} can have at most 2 decimals!` });

const codeSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/, "Code may contain letters, digits and . _ - (max 50)!")
  .or(z.literal(""))
  .nullish();

const catalogueItemFields = {
  code: codeSchema,
  description: z.string().max(5000).nullish(),
  type: z.enum(catalogueItemTypes, { error: "Type should be MATERIAL, LABOUR or SERVICE!" }).optional(),
  unit: z.enum(units, { error: "Unit should be one of m, m2, m3, piece, hour or lump_sum!" }).optional(),
  unit_price: price("Unit price").optional(),
  cost_price: price("Cost price").optional(),
  vat_code: z.string().regex(/^[A-Z0-9_-]{1,20}$/, "Invalid VAT code!").optional(),
  service_type: z.string().max(50).nullish(),
};

const createCatalogueItem = z.object({
  body: z.object({
    ...catalogueItemFields,
    name: z.string({ error: "Name is required!" }).trim().min(1).max(255),
  }),
});

const updateCatalogueItem = z.object({
  body: z.object({
    ...catalogueItemFields,
    name: z.string().trim().min(1).max(255).optional(),
    is_active: z.boolean().optional(),
  }),
});

export const CatalogueValidation = {
  createCatalogueItem,
  updateCatalogueItem,
};
