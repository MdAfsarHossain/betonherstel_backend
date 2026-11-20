import { TLanguage } from "../../utils/i18n";
import { IAppointmentAddress } from "../planning/planning.interface";

export const billingIntervals = ["MONTHLY", "QUARTERLY", "YEARLY"] as const;
export type TBillingInterval = (typeof billingIntervals)[number];

export const contractStatuses = ["ACTIVE", "PAUSED", "ENDED"] as const;
export type TContractStatus = (typeof contractStatuses)[number];

// Maintenance visits per year: the year splits evenly into visits
export const visitsPerYearOptions = [0, 1, 2, 3, 4, 6, 12] as const;

export interface IContractFields {
  title?: string;
  description?: string | null;
  address?: IAppointmentAddress | null;
  amount_excl_vat?: number;
  vat_code?: string;
  billing_interval?: TBillingInterval;
  end_date?: string | null;
  payment_term_days?: number;
  use_direct_debit?: boolean;
  language?: TLanguage;
  visits_per_year?: number;
  first_visit_date?: string | null;
  visit_assignee_ids?: string[];
  internal_notes?: string | null;
}

export interface ICreateContract extends IContractFields {
  relation_id: string;
  title: string;
  amount_excl_vat: number;
  billing_interval: TBillingInterval;
  start_date: string;
}

export type IUpdateContract = IContractFields;

export interface IEndContract {
  // The last day the contract runs. Leave out to end it today. Invoices already made stay.
  end_date?: string;
  reason?: string | null;
}
