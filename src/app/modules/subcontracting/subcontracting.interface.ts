// Uitbesteden (SRS 4.13): a part of a project given to a subcontractor.

export const assignmentStatuses = ["DRAFT", "SENT", "CONFIRMED", "DECLINED", "COMPLETED", "INVOICED", "CANCELLED"] as const;
export type TAssignmentStatus = (typeof assignmentStatuses)[number];

export const responseChannels = ["PHONE", "EMAIL", "IN_PERSON", "OTHER", "PORTAL"] as const;
export type TResponseChannel = (typeof responseChannels)[number];

export interface IWorkAddress {
  street: string;
  house_number: string;
  postcode: string;
  city: string;
  country?: string;
}

export interface IAssignmentHeader {
  title?: string;
  scope_description?: string;
  agreed_price_excl_vat?: number;
  vat_code?: string;
  planned_start?: string | null;
  planned_end?: string | null;
  work_address?: IWorkAddress | null;
  language?: "NL" | "EN";
  recipient_name?: string | null;
  recipient_email?: string | null;
  internal_notes?: string | null;
}

export interface ICreateAssignment extends IAssignmentHeader {
  project_id: string;
  subcontractor_id: string;
  title: string;
  scope_description: string;
  agreed_price_excl_vat: number;
}

export interface IRespondAssignment {
  response: "CONFIRM" | "DECLINE";
  via?: TResponseChannel;
  comment?: string | null;
  proposed_start?: string | null;
  proposed_end?: string | null;
}

export interface IProgressInput {
  percent: number;
  note?: string | null;
  via?: TResponseChannel;
}

export interface ICompleteAssignment {
  note?: string | null;
}

export interface IActor {
  id: string;
  role: string;
}
