export const entryTypes = ["WORK", "TRAVEL", "INSPECTION", "INTERNAL"] as const;
export type TEntryType = (typeof entryTypes)[number];

export const entryStatuses = ["SUBMITTED", "APPROVED", "REJECTED"] as const;
export type TEntryStatus = (typeof entryStatuses)[number];

export interface IActor {
  id: string;
  role: string;
}

export interface ICreateEntry {
  // Hours on a project or a work order; an INTERNAL entry has neither
  project_id?: string;
  work_order_id?: string;
  // The Amsterdam calendar day (default today), or derived from started_at
  work_date?: string;
  // Give minutes, or a start and an end time
  minutes?: number;
  started_at?: string;
  ended_at?: string;
  entry_type?: TEntryType;
  is_billable?: boolean;
  note?: string | null;
  // Makes a retried upload (a phone that was offline) safe
  client_id?: string;
  // Staff only: register hours for a colleague
  user_id?: string;
}

export interface IUpdateEntry {
  work_date?: string;
  minutes?: number;
  entry_type?: TEntryType;
  is_billable?: boolean;
  note?: string | null;
}

export interface IStartTimer {
  project_id?: string;
  work_order_id?: string;
  entry_type?: TEntryType;
  is_billable?: boolean;
  note?: string | null;
}

export interface IStopTimer {
  ended_at?: string;
  note?: string | null;
}

export interface IApprove {
  entry_ids?: string[];
  user_id?: string;
  week_start?: string;
}

export interface ISetRate {
  cost_rate: number;
  sales_rate: number;
  effective_from?: string;
}
