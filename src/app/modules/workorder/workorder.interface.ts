import { TUnit } from "../../utils/units";

export const workOrderStatuses = ["OPEN", "IN_PROGRESS", "COMPLETED", "CHECKED"] as const;
export type TWorkOrderStatus = (typeof workOrderStatuses)[number];

export const hourTypes = ["WORK", "TRAVEL"] as const;
export type THourType = (typeof hourTypes)[number];

export interface IWorkOrderAddress {
  street: string;
  house_number: string;
  postcode: string;
  city: string;
  country?: string;
}

export interface IChecklistItemInput {
  id?: string;
  text: string;
  is_required?: boolean;
}

export interface IMaterialInput {
  id?: string;
  catalogue_item_id?: string;
  description?: string;
  unit?: TUnit;
  quantity_planned: number;
  note?: string | null;
}

export interface ICreateWorkOrder {
  project_id: string;
  appointment_id?: string;
  title?: string;
  instructions?: string | null;
  planned_date?: string | null;
  address?: IWorkOrderAddress | null;
  internal_notes?: string | null;
  assignee_ids?: string[];
  checklist?: IChecklistItemInput[];
  materials?: IMaterialInput[];
}

export interface IUpdateWorkOrder {
  title?: string;
  instructions?: string | null;
  planned_date?: string | null;
  address?: IWorkOrderAddress | null;
  internal_notes?: string | null;
  assignee_ids?: string[];
}

export interface IHourInput {
  client_id?: string;
  work_date: string;
  minutes: number;
  entry_type?: THourType;
  is_billable?: boolean;
  note?: string | null;
  // Staff only: register hours for a colleague
  user_id?: string;
}

// What a phone sends when it has been offline: everything in one idempotent call (FR-WO-07)
export interface ISyncWorkOrder {
  work_performed?: string | null;
  notes?: string | null;
  checklist?: { id: string; is_done: boolean; done_at?: string }[];
  materials?: { id: string; quantity_used: number | null }[];
  extra_materials?: { client_id: string; description: string; unit: TUnit; quantity_used: number; note?: string | null }[];
  // client_id is required here: it is what makes a retried upload safe
  hours?: (Omit<IHourInput, "user_id" | "client_id"> & { client_id: string })[];
}

export interface ISignatureInput {
  signed_by_name: string;
  // data:image/png;base64,....
  signature: string;
}

export interface ICompleteWorkOrder {
  work_performed?: string | null;
  signed_by_name?: string;
  signature?: string;
}

export interface IActor {
  id: string;
  role: string;
}
