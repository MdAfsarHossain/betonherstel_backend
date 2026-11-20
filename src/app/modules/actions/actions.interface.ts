// Acties / tasks (SRS 4.16, FR-MSG-03, FR-MSG-04)

export const actionStatuses = ["OPEN", "DONE"] as const;
export type TActionStatus = (typeof actionStatuses)[number];

import { recordTypes, TRecordType } from "../../utils/records";

// The kinds of record a task can point at
export const actionEntityTypes = recordTypes;
export type TActionEntityType = TRecordType;

// Automatic tasks for key events (FR-MSG-04). The last two are made by modules that are not built yet.
export const actionAutoTypes = [
  "new_inquiry",
  "quote_follow_up",
  "invoice_overdue",
  "direct_debit_failed",
  "snelstart_sync_error",
] as const;
export type TActionAutoType = (typeof actionAutoTypes)[number];

export interface IActionEntity {
  type: TActionEntityType;
  id: string;
}

export interface ICreateAction {
  title: string;
  description?: string | null;
  due_date?: string | null;
  // omitted = the creator; null = nobody yet (the team picks it up)
  assignee_id?: string | null;
  entity?: IActionEntity | null;
}

export type IUpdateAction = Partial<ICreateAction>;

export interface ICreateAutomaticAction {
  auto_type: TActionAutoType;
  // makes the task idempotent: the same event never creates a second task
  auto_key: string;
  title: string;
  description?: string | null;
  due_date?: string | null;
  assignee_id?: string | null;
  entity?: IActionEntity | null;
}

export interface IActor {
  id: string;
  role: string;
}
