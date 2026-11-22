// The CRM fields a website form field can be mapped to (FR-HOOK-03)
export const crmFields = [
  "contact_name",
  "contact_email",
  "contact_phone",
  "company_name",
  "relation_type",
  "service_type",
  "description",
  "language",
  "street",
  "house_number",
  "postcode",
  "city",
  "country",
  "external_ref",
] as const;

export type TCrmField = (typeof crmFields)[number];

export type TWebhookStatus = "ACCEPTED" | "DUPLICATE" | "REJECTED" | "INVALID" | "INACTIVE" | "ERROR";

export interface IWebhookResult {
  httpStatus: number;
  body: Record<string, any>;
}
