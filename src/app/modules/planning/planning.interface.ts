import { TLanguage } from "../../utils/i18n";

export const appointmentTypes = ["INSPECTION", "PROJECT_WORK", "MAINTENANCE", "INTERNAL"] as const;

export type TAppointmentType = (typeof appointmentTypes)[number];

export const appointmentStatuses = ["PLANNED", "COMPLETED", "CANCELLED"] as const;

export type TAppointmentStatus = (typeof appointmentStatuses)[number];

// Roles that can be put on an appointment: the office and the field crew
export const assignableRoles = ["ADMIN", "OFFICE", "FIELD"];

export const appointmentTypeLabels: Record<TAppointmentType, Record<TLanguage, string>> = {
  INSPECTION: { NL: "Schouw", EN: "Inspection" },
  PROJECT_WORK: { NL: "Uitvoering", EN: "Project work" },
  MAINTENANCE: { NL: "Onderhoud", EN: "Maintenance visit" },
  INTERNAL: { NL: "Intern", EN: "Internal" },
};

export interface IAppointmentAddress {
  street: string;
  house_number: string;
  postcode: string;
  city: string;
  country?: string;
}

export interface ICreateAppointment {
  type: TAppointmentType;
  title?: string;
  // ISO 8601 with a time zone, e.g. 2026-11-20T09:00:00+01:00
  starts_at: string;
  ends_at: string;
  all_day?: boolean;
  relation_id?: string;
  inquiry_id?: string;
  project_id?: string;
  address?: IAppointmentAddress | null;
  notes?: string | null;
  assignee_ids?: string[];
  // Email the customer a confirmation with a calendar file (FR-PLAN-07)
  send_confirmation?: boolean;
}

export interface IUpdateAppointment {
  type?: TAppointmentType;
  title?: string;
  starts_at?: string;
  ends_at?: string;
  all_day?: boolean;
  // Link to (or, with null, unlink from) a project of the same customer
  project_id?: string | null;
  address?: IAppointmentAddress | null;
  notes?: string | null;
  assignee_ids?: string[];
}
