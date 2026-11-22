// SnelStart accounting integration (SRS 4.21). The CRM is the source of truth for quotations and invoices;
// SnelStart is the bookkeeping system. Bookings flow from the CRM to SnelStart, with a read-back of settled invoices.

export const entityTypes = ["SALES_INVOICE", "PURCHASE_INVOICE"] as const;
export type TEntityType = (typeof entityTypes)[number];

// PENDING: waiting to be sent (or to be retried); SENDING: a sync is working on it; SENT: booked in SnelStart;
// FAILED: needs a person (fix, then retry); SKIPPED: a person decided it must not be sent (booked by hand);
// CANCELLED: withdrawn before it was sent (a supplier invoice that was unapproved or voided)
export const itemStatuses = ["PENDING", "SENDING", "SENT", "FAILED", "SKIPPED", "CANCELLED"] as const;
export type TItemStatus = (typeof itemStatuses)[number];

export const connectionStatuses = ["DISCONNECTED", "CONNECTED", "ERROR"] as const;
export type TConnectionStatus = (typeof connectionStatuses)[number];

// How the lines of a booking carry VAT in SnelStart (the `btwSoort` of a booking line) ...
export const lineBtwSoorten = ["Geen", "Laag", "Hoog", "Overig"] as const;
// ... and how the VAT amounts of a booking are labelled (the `btwSoort` of a VAT entry)
export const salesBtwRegelSoorten = ["Geen", "VerkopenLaag", "VerkopenHoog", "VerkopenOverig", "VerkopenVerlegd"] as const;
export const purchaseBtwRegelSoorten = ["Geen", "InkopenLaag", "InkopenHoog", "InkopenOverig", "InkopenVerlegd"] as const;

export interface IVatMapping {
  line_btw_soort: (typeof lineBtwSoorten)[number];
  sales_btw_regel_soort: (typeof salesBtwRegelSoorten)[number];
  purchase_btw_regel_soort: (typeof purchaseBtwRegelSoorten)[number];
}

// What the CRM's default VAT codes become until the Beheerder (with the accountant) changes them
export const defaultVatMapping = (code: string, rate: number, reverseCharge: boolean): IVatMapping => {
  if (reverseCharge) return { line_btw_soort: "Geen", sales_btw_regel_soort: "VerkopenVerlegd", purchase_btw_regel_soort: "InkopenVerlegd" };
  if (rate >= 15) return { line_btw_soort: "Hoog", sales_btw_regel_soort: "VerkopenHoog", purchase_btw_regel_soort: "InkopenHoog" };
  if (rate > 0) return { line_btw_soort: "Laag", sales_btw_regel_soort: "VerkopenLaag", purchase_btw_regel_soort: "InkopenLaag" };
  return { line_btw_soort: "Geen", sales_btw_regel_soort: "Geen", purchase_btw_regel_soort: "Geen" };
};

export const ledgerKinds = ["REVENUE", "COST"] as const;
export type TLedgerKind = (typeof ledgerKinds)[number];

export const MAX_ATTEMPTS = 8;
export const BATCH_SIZE = 20;
export const BALANCE_BATCH = 20;
export const BALANCE_RECHECK_MINUTES = 10;
export const STALE_SENDING_MINUTES = 10;
