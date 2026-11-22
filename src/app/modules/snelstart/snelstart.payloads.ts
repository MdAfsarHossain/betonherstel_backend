import { IVatMapping } from "./snelstart.interface";

// What the CRM sends to SnelStart. Every wire-level name lives in this one file: if SnelStart's own documentation
// (or the development subscription) shows that a name or format differs, this is the only place to change.

// SnelStart takes dates as date-times; the CRM only knows calendar days
export const sDate = (day: string) => `${day}T00:00:00`;

// Amounts are worked out in cents everywhere; SnelStart gets decimals with two places
export const sMoney = (cents: number) => Math.round(cents) / 100;

export const normalizeVatNumber = (v?: string | null) => (v ? String(v).replace(/[\s.]/g, "").toUpperCase() : null);

export interface IRelationInput {
  id: string;
  name: string;
  email?: string | null;
  invoice_email?: string | null;
  phone?: string | null;
  kvk_number?: string | null;
  vat_number?: string | null;
  iban?: string | null;
  payment_term_days?: number | null;
  billing_street?: string | null;
  billing_house_number?: string | null;
  billing_postcode?: string | null;
  billing_city?: string | null;
}

// A customer is a "Klant", a supplier or subcontractor a "Leverancier"
export const buildRelatie = (relation: IRelationInput, role: "Klant" | "Leverancier", landId: string | null) => {
  const street = [relation.billing_street, relation.billing_house_number].filter(Boolean).join(" ");
  const hasAddress = !!(street || relation.billing_postcode || relation.billing_city);
  return {
    relatiesoort: [role],
    naam: relation.name.slice(0, 100),
    ...(relation.invoice_email || relation.email ? { email: relation.invoice_email ?? relation.email } : {}),
    ...(relation.phone ? { telefoon: relation.phone } : {}),
    ...(relation.kvk_number ? { kvkNummer: relation.kvk_number } : {}),
    ...(relation.vat_number ? { btwNummer: normalizeVatNumber(relation.vat_number) } : {}),
    ...(relation.iban ? { iban: relation.iban.replace(/\s/g, "").toUpperCase() } : {}),
    ...(relation.payment_term_days != null ? { krediettermijn: relation.payment_term_days } : {}),
    ...(hasAddress
      ? { vestigingsAdres: { straat: street || undefined, postcode: relation.billing_postcode ?? undefined, plaats: relation.billing_city ?? undefined, ...(landId ? { land: { id: landId } } : {}) } }
      : {}),
  };
};

export interface IBookingLine {
  description: string;
  grootboekId: string;
  amountCents: number;
  vat: IVatMapping;
}
export interface IBookingVat {
  btwSoort: string;
  amountCents: number;
}

// A sales booking (verkoopboeking): one line per ledger account and VAT code, the VAT amounts, and the totals.
// A credit note is the same with negative amounts.
export const buildSalesBooking = (input: {
  number: string;
  customerId: string;
  invoiceDate: string;
  dueDate: string;
  paymentTermDays: number;
  description: string;
  totalCents: number;
  lines: IBookingLine[];
  vat: IBookingVat[];
}) => ({
  factuurnummer: input.number,
  klant: { id: input.customerId },
  factuurDatum: sDate(input.invoiceDate),
  vervalDatum: sDate(input.dueDate),
  betalingstermijn: input.paymentTermDays,
  omschrijving: input.description.slice(0, 200),
  factuurBedrag: sMoney(input.totalCents),
  boekingsregels: input.lines.map((l) => ({
    omschrijving: l.description.slice(0, 200),
    grootboek: { id: l.grootboekId },
    bedrag: sMoney(l.amountCents),
    btwSoort: l.vat.line_btw_soort,
  })),
  btw: input.vat.map((v) => ({ btwSoort: v.btwSoort, btwBedrag: sMoney(v.amountCents) })),
});

// A purchase booking (inkoopboeking): the supplier's own invoice number and amounts
export const buildPurchaseBooking = (input: {
  number: string;
  supplierId: string;
  invoiceDate: string;
  dueDate: string;
  description: string;
  totalCents: number;
  lines: IBookingLine[];
  vat: IBookingVat[];
}) => ({
  factuurnummer: input.number,
  leverancier: { id: input.supplierId },
  factuurDatum: sDate(input.invoiceDate),
  vervalDatum: sDate(input.dueDate),
  omschrijving: input.description.slice(0, 200),
  factuurBedrag: sMoney(input.totalCents),
  boekingsregels: input.lines.map((l) => ({
    omschrijving: l.description.slice(0, 200),
    grootboek: { id: l.grootboekId },
    bedrag: sMoney(l.amountCents),
    btwSoort: l.vat.line_btw_soort,
  })),
  btw: input.vat.map((v) => ({ btwSoort: v.btwSoort, btwBedrag: sMoney(v.amountCents) })),
});

// The PDF of the invoice, attached to its booking
export const buildDocument = (parentId: string, fileName: string, content: Buffer) => ({
  parentIdentifier: parentId,
  fileName,
  content: content.toString("base64"),
});
