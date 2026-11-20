import httpStatus from "http-status";
import ApiError from "../errors/ApiError";
import assertUuid from "./assertUuid";
import { query } from "./db";

// The kinds of record that tasks, comments and notifications can point at.
// One place for the table behind each kind, a readable label and the page in the web app.

export const recordTypes = [
  "relation",
  "inquiry",
  "quote",
  "project",
  "appointment",
  "work_order",
  "invoice",
  "purchase_order",
  "supplier_invoice",
  "subcontract_assignment",
  "subscription",
] as const;
export type TRecordType = (typeof recordTypes)[number];

export const recordTables: Record<TRecordType, string> = {
  relation: "relations",
  inquiry: "inquiries",
  quote: "quotes",
  project: "projects",
  appointment: "appointments",
  work_order: "work_orders",
  invoice: "invoices",
  purchase_order: "purchase_orders",
  supplier_invoice: "supplier_invoices",
  subcontract_assignment: "subcontract_assignments",
  subscription: "subscriptions",
};

// SQL for a readable name of a record, given the columns that hold its type and id
export const recordLabelSql = (typeColumn: string, idColumn: string) => `
  CASE ${typeColumn}
    WHEN 'relation' THEN (SELECT name FROM relations WHERE id = ${idColumn})
    WHEN 'inquiry' THEN (SELECT reference FROM inquiries WHERE id = ${idColumn})
    WHEN 'quote' THEN (SELECT number FROM quotes WHERE id = ${idColumn})
    WHEN 'project' THEN (SELECT number FROM projects WHERE id = ${idColumn})
    WHEN 'appointment' THEN (SELECT title FROM appointments WHERE id = ${idColumn})
    WHEN 'work_order' THEN (SELECT number FROM work_orders WHERE id = ${idColumn})
    WHEN 'invoice' THEN (SELECT COALESCE(number, 'Draft invoice') FROM invoices WHERE id = ${idColumn})
    WHEN 'purchase_order' THEN (SELECT COALESCE(number, 'Draft purchase order') FROM purchase_orders WHERE id = ${idColumn})
    WHEN 'supplier_invoice' THEN (SELECT invoice_number FROM supplier_invoices WHERE id = ${idColumn})
    WHEN 'subcontract_assignment' THEN (SELECT COALESCE(number, 'Draft assignment') FROM subcontract_assignments WHERE id = ${idColumn})
    WHEN 'subscription' THEN (SELECT number FROM subscriptions WHERE id = ${idColumn})
  END
`;

export const assertRecordType = (type: string) => {
  if (!(recordTypes as readonly string[]).includes(type)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Unknown kind of record!");
  }
  return type as TRecordType;
};

export const assertRecordExists = async (type: string, id: string) => {
  const kind = assertRecordType(type);
  assertUuid(id, "record id");
  const found = await query(`SELECT 1 FROM ${recordTables[kind]} WHERE id = $1::uuid`, [id]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, `The ${kind.replace(/_/g, " ")} was not found!`);
  }
};

// The path of the record's page in the web app (for links in emails)
const paths: Record<TRecordType, string> = {
  relation: "relations",
  inquiry: "inquiries",
  quote: "quotes",
  project: "projects",
  appointment: "planning/appointments",
  work_order: "work-orders",
  invoice: "invoices",
  purchase_order: "purchase-orders",
  supplier_invoice: "supplier-invoices",
  subcontract_assignment: "subcontract-assignments",
  subscription: "subscriptions",
};
export const recordWebPath = (type: TRecordType, id: string) => `/${paths[type]}/${id}`;
