import { enqueueSnelStart } from "../snelstart/snelstart.queue";
import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { loadLogo } from "../../lib/pdfService";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { buildCsv, csvAmount, csvDelimiter } from "../../utils/csv";
import { addDays, amsterdamToday, isValidDay } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { formatMoney } from "../../utils/formatters";
import { t, TLanguage, toLanguage } from "../../utils/i18n";
import { fromCents, lineAmountCents, toCents } from "../../utils/money";
import { createZip } from "../../utils/zip";
import { ProjectService } from "../project/project.service";
import { QuoteService } from "../quote/quote.service";
import { SettingsService } from "../settings/settings.service";
import { InvoiceDeliveryService } from "./invoice.delivery.service";
import {
  ICreateCreditNote,
  ICreateInvoice,
  IIssueInvoice,
  IUpdateInvoice,
  invoiceKinds,
  invoiceStatuses,
  paymentStatuses,
} from "./invoice.interface";
import { buildInvoicePdf } from "./invoice.pdf";
import { InvoicePaymentService } from "./invoice.payment.service";
import {
  clean,
  IInvoiceLine,
  insertLines,
  invoiceColumns,
  invoiceJoins,
  lockInvoice,
  logInvoiceEvent,
  readInvoice,
  recomputePaymentStatus,
  recomputeTotals,
  round2,
  todaySql,
} from "./invoice.shared";

// Facturen (SRS 4.14). A draft is built from a quotation, a project (budget, additional
// work, approved hours), an instalment of a project, a final invoice that settles the rest,
// or by hand. Issuing gives it its number and PDF and locks it (FR-INV-04, FR-INV-06);
// corrections are credit notes (FR-INV-03). Payments and reminders live in the payment and
// delivery services.

const customerTypes = ["PRIVATE", "BUSINESS", "VVE"];
const MAX_EXPORT_DAYS = 366;
const MAX_EXPORT_INVOICES = 500;

const asList = (value: any): string[] =>
  String(Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const assertDay = (value: any, label: string) => {
  const day = String(value);
  if (!isValidDay(day)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `${label} must be a date like 2026-11-30!`,
    );
  }
  return day;
};

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const loadRelation = async (client: any, id: string) => {
  assertUuid(id, "relation id");
  const result = await client.query(
    `
      SELECT r.id, r.type::text AS type, r.name, r.email, r.invoice_email, r.preferred_language::text AS preferred_language,
             r.payment_term_days, r.vat_number, r.kvk_number,
             r.billing_street, r.billing_house_number, r.billing_postcode, r.billing_city, r.billing_country,
             pc.name AS contact_name, pc.email AS contact_email
      FROM relations r
      LEFT JOIN relation_contacts pc ON pc.relation_id = r.id AND pc.is_primary
      WHERE r.id = $1::uuid
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Relation not found!");
  }
  const relation = result.rows[0];
  if (!customerTypes.includes(relation.type)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "An invoice can only be made for a customer!",
    );
  }
  return relation;
};

// The customer's details as they are on the invoice: they never change afterwards
const customerSnapshot = (relation: any) => ({
  customer_name: relation.name,
  customer_street: relation.billing_street ?? null,
  customer_house_number: relation.billing_house_number ?? null,
  customer_postcode: relation.billing_postcode ?? null,
  customer_city: relation.billing_city ?? null,
  customer_country: relation.billing_country ?? null,
  customer_vat_number: relation.vat_number ?? null,
  customer_kvk_number: relation.kvk_number ?? null,
});

interface INewInvoice {
  kind: string;
  source: string;
  relation: any;
  projectId?: string | null;
  quoteId?: string | null;
  creditForId?: string | null;
  title?: string | null;
  language: TLanguage;
  paymentTermDays: number;
  recipientName?: string | null;
  recipientEmail?: string | null;
  introText?: string | null;
  footerText?: string | null;
  internalNotes?: string | null;
  creditReason?: string | null;
  instalmentNumber?: number | null;
  instalmentPercentage?: number | null;
  snapshot?: Record<string, any>;
  createdBy: string;
}

const insertInvoice = async (client: any, n: INewInvoice) => {
  const snap = n.snapshot ?? customerSnapshot(n.relation);
  const result = await client.query(
    `
      INSERT INTO invoices (
        kind, source, relation_id, project_id, quote_id, credit_for_id, language, title,
        recipient_name, recipient_email,
        customer_name, customer_street, customer_house_number, customer_postcode, customer_city,
        customer_country, customer_vat_number, customer_kvk_number,
        payment_term_days, instalment_number, instalment_percentage,
        intro_text, footer_text, internal_notes, credit_reason, created_by
      ) VALUES (
        $1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::"Language", $8,
        $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18,
        $19, $20, $21,
        $22, $23, $24, $25, $26::uuid
      ) RETURNING id
    `,
    [
      n.kind,
      n.source,
      n.relation.id,
      n.projectId ?? null,
      n.quoteId ?? null,
      n.creditForId ?? null,
      n.language,
      n.title ?? null,
      n.recipientName ?? null,
      n.recipientEmail ?? null,
      snap.customer_name,
      snap.customer_street,
      snap.customer_house_number,
      snap.customer_postcode,
      snap.customer_city,
      snap.customer_country,
      snap.customer_vat_number,
      snap.customer_kvk_number,
      n.paymentTermDays,
      n.instalmentNumber ?? null,
      n.instalmentPercentage ?? null,
      n.introText ?? null,
      n.footerText ?? null,
      n.internalNotes ?? null,
      n.creditReason ?? null,
      n.createdBy,
    ],
  );
  return result.rows[0].id as string;
};

const vatKey = (l: {
  vat_code: string;
  vat_rate: number;
  vat_reverse_charge: boolean;
}) => `${l.vat_code}|${l.vat_rate}|${l.vat_reverse_charge}`;

// Spreads an amount over VAT groups in proportion to their size, to the cent. The rounding
// difference goes on the biggest group, so the parts always add up exactly.
const allocate = (amountCents: number, baseCents: number[]) => {
  const total = baseCents.reduce((n, b) => n + b, 0);
  const parts = baseCents.map((b) => {
    const exact = (amountCents * b) / total;
    return Math.sign(exact) * Math.round(Math.abs(exact));
  });
  const diff = amountCents - parts.reduce((n, p) => n + p, 0);
  let biggest = 0;
  baseCents.forEach((b, i) => {
    if (Math.abs(b) > Math.abs(baseCents[biggest])) biggest = i;
  });
  parts[biggest] += diff;
  return parts;
};

const vatLabel = (
  g: { vat_rate: number; vat_reverse_charge: boolean },
  language: TLanguage,
) =>
  g.vat_reverse_charge
    ? `${t(language, "vat")} ${language === "NL" ? "verlegd" : "reverse-charged"}`
    : `${t(language, "vat")} ${g.vat_rate}%`;

// The default VAT code for lines we make ourselves (hours): 21% if it exists
const defaultVat = async () => {
  const company = await SettingsService.getCompanySettings();
  const rates: { code: string; rate: number; reverse_charge: boolean }[] =
    company.vat_rates;
  const rate =
    rates.find((v) => v.code === "21") ??
    rates.find((v) => !v.reverse_charge) ??
    rates[0];
  return {
    vat_code: rate.code,
    vat_rate: rate.rate,
    vat_reverse_charge: rate.reverse_charge,
  };
};

const projectContext = async (client: any, projectId: string) => {
  assertUuid(projectId, "project id");
  const result = await client.query(
    `
      SELECT id, number, title, relation_id, closed_at, contact_name, contact_email,
             budget_excl_vat::float8 AS budget_excl_vat
      FROM projects WHERE id = $1::uuid FOR UPDATE
    `,
    [projectId],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }
  return result.rows[0];
};

// Invoices of a project that are not credited away, by kind (drafts count: they claim their share)
const activeProjectInvoices = async (
  client: any,
  projectId: string,
  kinds: string[],
) => {
  const result = await client.query(
    `
      SELECT id, number, kind, status, payment_status, total_excl_vat::float8 AS total_excl_vat,
             total_incl_vat::float8 AS total_incl_vat, credited_amount::float8 AS credited_amount
      FROM invoices
      WHERE project_id = $1::uuid AND kind = ANY($2::"InvoiceKind"[]) AND payment_status IS DISTINCT FROM 'CREDITED'
      ORDER BY created_at ASC
    `,
    [projectId, kinds],
  );
  return result.rows;
};

// Hours that are approved, billable and not on an invoice yet, one line per employee and rate.
// The exact total of the entries is kept (no rounding of hours x rate).
const collectHours = async (
  client: any,
  projectId: string,
  language: TLanguage,
) => {
  const entries = await client.query(
    `
      SELECT t.id, t.minutes, t.sales_rate_cents, t.sales_cents, u.id AS user_id, u.name
      FROM time_entries t JOIN users u ON u.id = t.user_id
      WHERE t.project_id = $1::uuid AND t.status = 'APPROVED' AND t.is_billable AND t.invoice_id IS NULL
      ORDER BY u.name ASC, t.work_date ASC
      FOR UPDATE OF t
    `,
    [projectId],
  );
  if (entries.rows.some((e: any) => e.sales_rate_cents === null)) {
    throw new ApiError(
      httpStatus.CONFLICT,
      "Some approved hours have no sales rate. Set the rate, then unapprove and approve those hours again!",
    );
  }

  const vat = await defaultVat();
  const groups = new Map<
    string,
    { name: string; rateCents: number; minutes: number; cents: number }
  >();
  for (const e of entries.rows) {
    const key = `${e.user_id}|${e.sales_rate_cents}`;
    const g = groups.get(key) ?? {
      name: e.name,
      rateCents: e.sales_rate_cents,
      minutes: 0,
      cents: 0,
    };
    g.minutes += e.minutes;
    g.cents += e.sales_cents;
    groups.set(key, g);
  }

  const lines: IInvoiceLine[] = [...groups.values()]
    .filter((g) => g.cents !== 0)
    .map((g) => ({
      section_title: t(language, "inv_hours_line"),
      line_type: "HOURS" as const,
      description: `${t(language, "inv_hours_line")} ${g.name}: ${round2(g.minutes / 60)} ${t(language, "inv_hours_at")} ${formatMoney(fromCents(g.rateCents), language)}`,
      quantity: 1,
      unit: "lump_sum",
      unit_price: fromCents(g.cents),
      ...vat,
    }));
  return { lines, entryIds: entries.rows.map((e: any) => e.id as string) };
};

const projectLines = async (
  client: any,
  projectId: string,
  kinds: string[],
) => {
  const result = await client.query(
    `
      SELECT id, kind, section_title, catalogue_item_id, description, quantity::float8 AS quantity, unit,
             unit_price::float8 AS unit_price, vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge
      FROM project_lines
      WHERE project_id = $1::uuid AND invoice_id IS NULL AND kind = ANY($2::text[])
      ORDER BY kind ASC, sort_order ASC
      FOR UPDATE
    `,
    [projectId, kinds],
  );
  return result.rows;
};

const toInvoiceLine = (l: any): IInvoiceLine => ({
  section_title: l.section_title ?? null,
  line_type: "PROJECT",
  catalogue_item_id: l.catalogue_item_id ?? null,
  description: l.description,
  quantity: l.quantity,
  unit: l.unit,
  unit_price: l.unit_price,
  vat_code: l.vat_code,
  vat_rate: l.vat_rate,
  vat_reverse_charge: l.vat_reverse_charge,
});

const createInvoice = async (input: ICreateInvoice, actorId: string) => {
  const preparedManual =
    input.source === "MANUAL" && input.sections
      ? await QuoteService.prepareSections(input.sections)
      : null;

  const id = await transaction(async (client) => {
    let relation: any;
    let project: any = null;
    let quote: any = null;
    let lines: IInvoiceLine[] = [];
    let title: string | null = clean(input.title);
    let kind = "STANDARD";
    let instalmentNumber: number | null = null;
    let instalmentPercentage: number | null = null;
    let markLines: string[] = [];
    let markEntries: string[] = [];

    if (input.source === "MANUAL") {
      relation = await loadRelation(client, input.relation_id as string);
      if (input.project_id) {
        project = await projectContext(client, input.project_id);
        if (project.relation_id !== relation.id) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            "This project belongs to another customer!",
          );
        }
      }
      for (const section of preparedManual ?? []) {
        for (const l of section.lines) {
          lines.push({
            section_title: section.title,
            line_type: "MANUAL",
            catalogue_item_id: l.catalogue_item_id,
            description: l.description,
            quantity: l.quantity,
            unit: l.unit,
            unit_price: l.unit_price,
            vat_code: l.vat_code,
            vat_rate: l.vat_rate,
            vat_reverse_charge: l.vat_reverse_charge,
          });
        }
      }
    } else if (input.source === "QUOTE") {
      assertUuid(input.quote_id as string, "quote id");
      const found = await client.query(
        `SELECT id, number, status, relation_id, title, recipient_name, recipient_email FROM quotes WHERE id = $1::uuid FOR UPDATE`,
        [input.quote_id],
      );
      if (found.rows.length === 0) {
        throw new ApiError(httpStatus.NOT_FOUND, "Quotation not found!");
      }
      quote = found.rows[0];
      if (quote.status !== "ACCEPTED") {
        throw new ApiError(
          httpStatus.CONFLICT,
          "Only an accepted quotation can be invoiced!",
        );
      }
      const existingProject = await client.query(
        `SELECT number FROM projects WHERE quote_id = $1::uuid`,
        [quote.id],
      );

      if (existingProject.rows.length > 0) {
        throw new ApiError(
          httpStatus.CONFLICT,
          `This quotation already has project ${existingProject.rows[0].number}. Invoice from the project instead!`,
        );
      }
      const existingInvoice = await client.query(
        `SELECT number FROM invoices WHERE quote_id = $1::uuid AND kind <> 'CREDIT_NOTE' AND payment_status IS DISTINCT FROM 'CREDITED'`,
        [quote.id],
      );
      if (existingInvoice.rows.length > 0) {
        throw new ApiError(
          httpStatus.CONFLICT,
          `This quotation already has an invoice${existingInvoice.rows[0].number ? ` (${existingInvoice.rows[0].number})` : " (a draft)"}!`,
        );
      }
      relation = await loadRelation(client, quote.relation_id);
      title = title ?? quote.title;

      const quoteLines = await client.query(
        `
          SELECT s.title AS section_title, l.catalogue_item_id, l.description, l.quantity::float8 AS quantity, l.unit,
                 l.unit_price::float8 AS unit_price, l.vat_code, l.vat_rate::float8 AS vat_rate, l.vat_reverse_charge
          FROM quote_lines l JOIN quote_sections s ON s.id = l.section_id
          WHERE l.quote_id = $1::uuid ORDER BY s.sort_order ASC, l.sort_order ASC
        `,
        [quote.id],
      );
      lines = quoteLines.rows.map((l: any) => ({
        ...l,
        line_type: "QUOTE" as const,
      }));
    } else {
      // PROJECT, INSTALMENT and FINAL all start from a project
      project = await projectContext(client, input.project_id as string);
      relation = await loadRelation(client, project.relation_id);
      title = title ?? project.title;
      const language =
        input.language ?? toLanguage(relation.preferred_language);

      if (input.source === "PROJECT") {
        const include = {
          budget: true,
          additional: true,
          hours: false,
          ...(input.include ?? {}),
        };
        if (
          include.budget &&
          (await activeProjectInvoices(client, project.id, ["INSTALMENT"]))
            .length > 0
        ) {
          throw new ApiError(
            httpStatus.CONFLICT,
            "This project is invoiced in instalments. Make a final invoice to settle the rest!",
          );
        }
        const kinds = [
          include.budget ? "BUDGET" : null,
          include.additional ? "ADDITIONAL" : null,
        ].filter(Boolean) as string[];
        const rows = kinds.length
          ? await projectLines(client, project.id, kinds)
          : [];
        lines = rows.map(toInvoiceLine);
        markLines = rows.map((r: any) => r.id);
        if (include.hours) {
          const hours = await collectHours(client, project.id, language);
          lines.push(...hours.lines);
          markEntries = hours.entryIds;
        }
        if (lines.length === 0) {
          throw new ApiError(
            httpStatus.CONFLICT,
            "There is nothing left to invoice for this project!",
          );
        }
      } else if (input.source === "INSTALMENT") {
        kind = "INSTALMENT";
        if (
          (await activeProjectInvoices(client, project.id, ["FINAL"])).length >
          0
        ) {
          throw new ApiError(
            httpStatus.CONFLICT,
            "This project already has a final invoice!",
          );
        }
        const budget = await client.query(
          `
            SELECT vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge, quantity::float8 AS quantity,
                   unit_price::float8 AS unit_price, (invoice_id IS NOT NULL) AS invoiced
            FROM project_lines WHERE project_id = $1::uuid AND kind = 'BUDGET'
          `,
          [project.id],
        );
        if (budget.rows.length === 0) {
          throw new ApiError(
            httpStatus.CONFLICT,
            "This project has no budget to invoice in instalments!",
          );
        }
        if (budget.rows.some((l: any) => l.invoiced)) {
          throw new ApiError(
            httpStatus.CONFLICT,
            "The budget of this project has already been invoiced!",
          );
        }

        // The budget per VAT rate, so every instalment carries VAT the way the whole job does
        const groups = new Map<string, any>();
        for (const l of budget.rows) {
          const g = groups.get(vatKey(l)) ?? { ...l, baseCents: 0 };
          g.baseCents += lineAmountCents(l.quantity, toCents(l.unit_price));
          groups.set(vatKey(l), g);
        }
        const groupList = [...groups.values()];
        const budgetCents = groupList.reduce((n, g) => n + g.baseCents, 0);
        if (budgetCents <= 0) {
          throw new ApiError(
            httpStatus.CONFLICT,
            "The budget of this project is not positive!",
          );
        }

        const amountCents =
          input.percentage !== undefined
            ? Math.round(
                (budgetCents * Math.round(input.percentage * 1000)) / 100_000,
              )
            : toCents(input.amount as number);
        const earlier = await activeProjectInvoices(client, project.id, [
          "INSTALMENT",
        ]);
        const earlierCents = earlier.reduce(
          (n: number, i: any) => n + toCents(i.total_excl_vat),
          0,
        );
        if (amountCents <= 0 || earlierCents + amountCents > budgetCents) {
          throw new ApiError(
            httpStatus.CONFLICT,
            `Instalments cannot be more than the project budget (${formatMoney(fromCents(budgetCents - earlierCents), language)} is left)!`,
          );
        }

        instalmentNumber = earlier.length + 1;
        instalmentPercentage =
          input.percentage ?? round2((amountCents / budgetCents) * 100);
        const parts = allocate(
          amountCents,
          groupList.map((g) => g.baseCents),
        );
        lines = groupList
          .map((g, i) => ({
            section_title: null,
            line_type: "INSTALMENT" as const,
            description:
              `${t(language, "inv_instalment")} ${instalmentNumber}` +
              (input.percentage !== undefined
                ? ` (${input.percentage}% ${t(language, "inv_instalment_of")})`
                : "") +
              (groupList.length > 1 ? ` - ${vatLabel(g, language)}` : ""),
            quantity: 1,
            unit: "lump_sum",
            unit_price: fromCents(parts[i]),
            vat_code: g.vat_code,
            vat_rate: g.vat_rate,
            vat_reverse_charge: g.vat_reverse_charge,
          }))
          .filter((l) => l.unit_price !== 0);
      } else {
        kind = "FINAL";
        const others = await activeProjectInvoices(client, project.id, [
          "FINAL",
          "INSTALMENT",
        ]);
        if (others.some((i: any) => i.kind === "FINAL")) {
          throw new ApiError(
            httpStatus.CONFLICT,
            "This project already has a final invoice!",
          );
        }
        const instalments = others.filter((i: any) => i.kind === "INSTALMENT");
        if (instalments.some((i: any) => i.status === "DRAFT")) {
          throw new ApiError(
            httpStatus.CONFLICT,
            "Issue or delete the draft instalment invoice first!",
          );
        }
        if (instalments.some((i: any) => i.credited_amount > 0)) {
          throw new ApiError(
            httpStatus.CONFLICT,
            "An instalment invoice is partly credited. Settle that before the final invoice!",
          );
        }

        const include = {
          additional: true,
          hours: false,
          ...(input.include ?? {}),
        };
        const kinds = [
          "BUDGET",
          include.additional ? "ADDITIONAL" : null,
        ].filter(Boolean) as string[];
        const rows = await projectLines(client, project.id, kinds);
        if (!rows.some((r: any) => r.kind === "BUDGET")) {
          throw new ApiError(
            httpStatus.CONFLICT,
            "The budget of this project has already been invoiced!",
          );
        }
        lines = rows.map(toInvoiceLine);
        markLines = rows.map((r: any) => r.id);
        if (include.hours) {
          const hours = await collectHours(client, project.id, language);
          lines.push(...hours.lines);
          markEntries = hours.entryIds;
        }

        // What was already invoiced as instalments comes off, per VAT rate
        for (const inst of instalments) {
          const instLines = await client.query(
            `
              SELECT vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge, line_total::float8 AS line_total
              FROM invoice_lines WHERE invoice_id = $1::uuid AND line_type = 'INSTALMENT' ORDER BY sort_order ASC
            `,
            [inst.id],
          );
          for (const il of instLines.rows) {
            lines.push({
              section_title: t(language, "inv_instalment"),
              line_type: "DEDUCTION",
              description: `${t(language, "inv_less_instalment")} ${inst.number}${instLines.rows.length > 1 ? ` - ${vatLabel(il, language)}` : ""}`,
              quantity: 1,
              unit: "lump_sum",
              unit_price: -il.line_total,
              vat_code: il.vat_code,
              vat_rate: il.vat_rate,
              vat_reverse_charge: il.vat_reverse_charge,
            });
          }
        }
      }
    }

    const company = await SettingsService.getCompanySettings(client);
    const language: TLanguage =
      input.language ?? toLanguage(relation.preferred_language);
    const invoiceId = await insertInvoice(client, {
      kind,
      source: input.source,
      relation,
      projectId: project?.id ?? null,
      quoteId: quote?.id ?? null,
      title,
      language,
      paymentTermDays:
        input.payment_term_days ??
        relation.payment_term_days ??
        company.default_payment_term_days,
      recipientName:
        clean(input.recipient_name) ??
        project?.contact_name ??
        quote?.recipient_name ??
        relation.contact_name ??
        relation.name,
      recipientEmail:
        clean(input.recipient_email)?.toLowerCase() ??
        relation.invoice_email ??
        project?.contact_email ??
        quote?.recipient_email ??
        relation.contact_email ??
        relation.email ??
        null,
      introText: clean(input.intro_text),
      footerText: clean(input.footer_text),
      internalNotes: clean(input.internal_notes),
      instalmentNumber,
      instalmentPercentage,
      createdBy: actorId,
    });

    await insertLines(client, invoiceId, lines);
    await recomputeTotals(client, invoiceId);

    // What is on this draft is claimed, so it cannot go on another invoice
    if (markLines.length) {
      await client.query(
        `UPDATE project_lines SET invoice_id = $1::uuid WHERE id = ANY($2::uuid[])`,
        [invoiceId, markLines],
      );
    }
    if (markEntries.length) {
      await client.query(
        `UPDATE time_entries SET invoice_id = $1::uuid WHERE id = ANY($2::uuid[])`,
        [invoiceId, markEntries],
      );
    }

    await logAudit(
      {
        actor_id: actorId,
        action: "CREATE",
        entity_type: "invoice",
        entity_id: invoiceId,
        changes: {
          source: input.source,
          kind,
          project_id: project?.id ?? null,
        },
      },
      client,
    );
    return invoiceId;
  });

  return readInvoice(id);
};

const lockDraft = async (client: any, id: string) => {
  const invoice = await lockInvoice(client, id);
  if (invoice.status !== "DRAFT") {
    throw new ApiError(
      httpStatus.CONFLICT,
      "An issued invoice is locked. Correct it with a credit note!",
    );
  }
  return invoice;
};

const updateInvoice = async (
  id: string,
  payload: IUpdateInvoice,
  actorId: string,
) => {
  await transaction(async (client) => {
    await lockDraft(client, id);

    const data: Record<string, any> = {};
    if (payload.title !== undefined) data.title = clean(payload.title);
    if (payload.language !== undefined) data.language = payload.language;
    if (payload.payment_term_days !== undefined)
      data.payment_term_days = payload.payment_term_days;
    if (payload.recipient_name !== undefined)
      data.recipient_name = clean(payload.recipient_name);
    if (payload.recipient_email !== undefined)
      data.recipient_email =
        clean(payload.recipient_email)?.toLowerCase() ?? null;
    if (payload.intro_text !== undefined)
      data.intro_text = clean(payload.intro_text);
    if (payload.footer_text !== undefined)
      data.footer_text = clean(payload.footer_text);
    if (payload.internal_notes !== undefined)
      data.internal_notes = clean(payload.internal_notes);

    const updates: string[] = [];
    const values: any[] = [];
    let n = 1;
    for (const [field, value] of Object.entries(data)) {
      updates.push(
        `${field} = $${n++}${field === "language" ? '::"Language"' : ""}`,
      );
      values.push(value);
    }
    if (updates.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
    }
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    await client.query(
      `UPDATE invoices SET ${updates.join(", ")} WHERE id = $${n}::uuid`,
      values,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "invoice",
        entity_id: id,
        changes: { fields: Object.keys(data) },
      },
      client,
    );
  });
  return readInvoice(id);
};

// Replaces the lines of a draft that was made by hand or copied from a quotation
const setItems = async (id: string, sections: any[], actorId: string) => {
  const prepared = await QuoteService.prepareSections(sections);

  await transaction(async (client) => {
    const invoice = await lockDraft(client, id);
    if (invoice.source !== "MANUAL" && invoice.source !== "QUOTE") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "The lines of this invoice come from the project. Delete the draft and make a new one to change them!",
      );
    }
    await client.query(
      `DELETE FROM invoice_lines WHERE invoice_id = $1::uuid`,
      [id],
    );
    const lines: IInvoiceLine[] = [];
    for (const section of prepared) {
      for (const l of section.lines) {
        lines.push({
          section_title: section.title,
          line_type: "MANUAL",
          catalogue_item_id: l.catalogue_item_id,
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unit_price: l.unit_price,
          vat_code: l.vat_code,
          vat_rate: l.vat_rate,
          vat_reverse_charge: l.vat_reverse_charge,
        });
      }
    }
    await insertLines(client, id, lines);
    await recomputeTotals(client, id);
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "invoice",
        entity_id: id,
        changes: { lines: lines.length },
      },
      client,
    );
  });
  return readInvoice(id);
};

// A draft has no number, so deleting it leaves no gap. What it had claimed is released.
const deleteInvoice = async (id: string, actorId: string) => {
  await transaction(async (client) => {
    const invoice = await lockDraft(client, id);
    await client.query(
      `UPDATE project_lines SET invoice_id = NULL WHERE invoice_id = $1::uuid`,
      [id],
    );
    await client.query(
      `UPDATE time_entries SET invoice_id = NULL WHERE invoice_id = $1::uuid`,
      [id],
    );
    await client.query(`DELETE FROM invoices WHERE id = $1::uuid`, [id]);
    await logAudit(
      {
        actor_id: actorId,
        action: "DELETE",
        entity_type: "invoice",
        entity_id: id,
        changes: { kind: invoice.kind, draft: true },
      },
      client,
    );
  });
};

// ---------------------------------------------------------------------------
// Credit notes (FR-INV-03)
// ---------------------------------------------------------------------------

// A credit note for the whole invoice (what is left to credit) or for chosen lines.
// It is made as a draft, like an invoice, and issued with its own number.
const createCreditNote = async (
  id: string,
  input: ICreateCreditNote,
  actorId: string,
) => {
  const creditId = await transaction(async (client) => {
    const original = await lockInvoice(client, id);
    if (original.status !== "ISSUED" || original.kind === "CREDIT_NOTE") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "A credit note can only be made for an issued invoice!",
      );
    }

    const lines = await client.query(
      `
        SELECT l.id, l.section_title, l.catalogue_item_id, l.description, l.quantity::float8 AS quantity, l.unit,
               l.unit_price::float8 AS unit_price, l.vat_code, l.vat_rate::float8 AS vat_rate, l.vat_reverse_charge,
               COALESCE((SELECT SUM(c.quantity) FROM invoice_lines c WHERE c.credits_line_id = l.id), 0)::float8 AS credited
        FROM invoice_lines l WHERE l.invoice_id = $1::uuid ORDER BY l.sort_order ASC
      `,
      [id],
    );
    const byId = new Map<string, any>(lines.rows.map((l: any) => [l.id, l]));
    const left = (l: any) =>
      Math.round((l.quantity - l.credited) * 1000) / 1000;

    let picks: { line: any; quantity: number }[];
    if (input.lines) {
      const seen = new Set<string>();
      picks = input.lines.map((p) => {
        const line = byId.get(p.invoice_line_id);
        if (!line) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            "A line does not belong to this invoice!",
          );
        }
        if (seen.has(line.id)) {
          throw new ApiError(httpStatus.BAD_REQUEST, "A line appears twice!");
        }
        seen.add(line.id);
        if (p.quantity > left(line) + 1e-9) {
          throw new ApiError(
            httpStatus.CONFLICT,
            `Only ${left(line)} of "${line.description}" is left to credit!`,
          );
        }
        return { line, quantity: p.quantity };
      });
    } else {
      picks = lines.rows
        .filter((l: any) => left(l) > 0)
        .map((l: any) => ({ line: l, quantity: left(l) }));
      if (picks.length === 0) {
        throw new ApiError(
          httpStatus.CONFLICT,
          "This invoice has already been credited in full!",
        );
      }
    }

    const source = await client.query(
      `
        SELECT i.*, r.id AS rel_id FROM invoices i JOIN relations r ON r.id = i.relation_id WHERE i.id = $1::uuid
      `,
      [id],
    );
    const o = source.rows[0];

    const creditInvoiceId = await insertInvoice(client, {
      kind: "CREDIT_NOTE",
      source: "CREDIT",
      relation: { id: o.relation_id },
      projectId: o.project_id,
      quoteId: null,
      creditForId: id,
      title: o.title,
      language: toLanguage(o.language),
      paymentTermDays: o.payment_term_days,
      recipientName: o.recipient_name,
      recipientEmail: o.recipient_email,
      creditReason: input.reason.trim(),
      // the customer as the original invoice showed them
      snapshot: {
        customer_name: o.customer_name,
        customer_street: o.customer_street,
        customer_house_number: o.customer_house_number,
        customer_postcode: o.customer_postcode,
        customer_city: o.customer_city,
        customer_country: o.customer_country,
        customer_vat_number: o.customer_vat_number,
        customer_kvk_number: o.customer_kvk_number,
      },
      createdBy: actorId,
    });

    // Credit lines carry a negative price, so every total works out negative
    for (const pick of picks) {
      const creditLine: IInvoiceLine = {
        section_title: pick.line.section_title,
        line_type: "CREDIT",
        catalogue_item_id: pick.line.catalogue_item_id,
        credits_line_id: pick.line.id,
        description: pick.line.description,
        quantity: pick.quantity,
        unit: pick.line.unit,
        unit_price: -pick.line.unit_price,
        vat_code: pick.line.vat_code,
        vat_rate: pick.line.vat_rate,
        vat_reverse_charge: pick.line.vat_reverse_charge,
      };
      await insertLines(client, creditInvoiceId, [creditLine]);
    }
    await recomputeTotals(client, creditInvoiceId);

    await logAudit(
      {
        actor_id: actorId,
        action: "CREATE",
        entity_type: "invoice",
        entity_id: creditInvoiceId,
        changes: { credit_for: id, reason: input.reason.trim() },
      },
      client,
    );
    return creditInvoiceId;
  });

  return readInvoice(creditId);
};

// ---------------------------------------------------------------------------
// Issuing (FR-INV-04, FR-INV-05, FR-INV-06)
// ---------------------------------------------------------------------------

const pdfInput = (
  inv: any,
  number: string,
  isDraft: boolean,
  company: any,
  language: TLanguage,
) => {
  const calc = inv.calculation;
  return {
    number,
    is_credit_note: inv.kind === "CREDIT_NOTE",
    invoice_date: inv.invoice_date ?? amsterdamToday(),
    due_date:
      inv.kind === "CREDIT_NOTE"
        ? null
        : (inv.due_date ?? addDays(amsterdamToday(), inv.payment_term_days)),
    title: inv.title,
    intro_text: inv.intro_text,
    footer_text: inv.footer_text,
    customer: { ...inv.customer, recipient_name: inv.recipient_name },
    project: inv.project,
    original_number: inv.credit_for?.number ?? null,
    reason: inv.credit_reason,
    sections: inv.sections.map((s: any) => ({
      title: s.title,
      lines: s.lines,
    })),
    vat: calc.vat,
    total_excl_vat: calc.total_excl_vat,
    total_incl_vat: calc.total_incl_vat,
    bank: {
      iban: company.iban,
      bic: company.bic,
      bank_name: company.bank_name,
    },
    isDraft,
    language,
  };
};

// Gives the invoice its number, date and PDF, and locks it. The number, the PDF and the
// lock happen in one transaction: if anything fails the number is not used up.
const issueInvoice = async (
  id: string,
  input: IIssueInvoice,
  actorId: string,
) => {
  const company = await SettingsService.getCompanySettings();
  const logo = await loadLogo(company.logo_url);

  const issued = await transaction(async (client) => {
    const invoice = await lockInvoice(client, id);
    if (invoice.status !== "DRAFT") {
      throw new ApiError(
        httpStatus.CONFLICT,
        "This invoice has already been issued!",
      );
    }
    const isCredit = invoice.kind === "CREDIT_NOTE";

    const totals = await recomputeTotals(client, id);
    if (totals.totalCents === 0) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "An invoice with a total of zero cannot be issued!",
      );
    }
    if (!isCredit && totals.totalCents < 0) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "The total is negative. Make a credit note instead!",
      );
    }
    if (isCredit && totals.totalCents > 0) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "A credit note must have a negative total!",
      );
    }

    // The customer's details as they are today (a credit note keeps the invoice's own)
    if (!isCredit) {
      const relation = await loadRelation(client, invoice.relation_id);
      const snap = customerSnapshot(relation);
      await client.query(
        `
          UPDATE invoices SET customer_name = $2, customer_street = $3, customer_house_number = $4, customer_postcode = $5,
                 customer_city = $6, customer_country = $7, customer_vat_number = $8, customer_kvk_number = $9
          WHERE id = $1::uuid
        `,
        [
          id,
          snap.customer_name,
          snap.customer_street,
          snap.customer_house_number,
          snap.customer_postcode,
          snap.customer_city,
          snap.customer_country,
          snap.customer_vat_number,
          snap.customer_kvk_number,
        ],
      );
    }

    const draft = await readInvoice(id, client);
    // Reverse-charged VAT needs the customer's VAT number on the invoice
    if (
      draft.calculation.vat.some((g: any) => g.reverse_charge) &&
      !clean(draft.customer.vat_number)
    ) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "Reverse-charged VAT needs the customer's VAT number. Add it to the relation first!",
      );
    }
    if (!clean(company.company_name)) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "Add the company details in the settings first!",
      );
    }

    if (isCredit) {
      // A line can only be credited once, over all issued credit notes
      const over = await client.query(
        `
          SELECT l.description
          FROM invoice_lines c
          JOIN invoice_lines l ON l.id = c.credits_line_id
          WHERE c.invoice_id = $1::uuid
            AND (SELECT COALESCE(SUM(x.quantity), 0) FROM invoice_lines x
                 JOIN invoices xi ON xi.id = x.invoice_id AND xi.status = 'ISSUED'
                 WHERE x.credits_line_id = l.id) + c.quantity > l.quantity
          LIMIT 1
        `,
        [id],
      );
      if (over.rows.length > 0) {
        throw new ApiError(
          httpStatus.CONFLICT,
          `"${over.rows[0].description}" has already been credited!`,
        );
      }
      // the original is locked while its credit is booked
      await lockInvoice(client, invoice.credit_for_id);
    }

    const number = await SettingsService.nextDocumentNumber(
      isCredit ? "credit_note" : "invoice",
      client,
    );
    const invoiceDate = amsterdamToday();
    const dueDate = isCredit
      ? null
      : addDays(invoiceDate, invoice.payment_term_days);

    await client.query(
      `
        UPDATE invoices
        SET number = $2, status = 'ISSUED', payment_status = $3, invoice_date = $4::date, due_date = $5::date,
            issued_at = CURRENT_TIMESTAMP, issued_by = $6::uuid, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [id, number, isCredit ? null : "OPEN", invoiceDate, dueDate, actorId],
    );

    // The PDF is made with the final number and stored as issued
    const issuedView = await readInvoice(id, client);
    const language = toLanguage(issuedView.language);
    const pdf = await buildInvoicePdf(
      pdfInput(issuedView, number, false, company, language),
      company,
      language,
      { logo },
    );
    await client.query(
      `UPDATE invoices SET pdf_data = $2 WHERE id = $1::uuid`,
      [id, pdf],
    );

    if (isCredit) {
      await recomputePaymentStatus(client, invoice.credit_for_id);
    }

    await logInvoiceEvent(
      client,
      { id, relation_id: invoice.relation_id },
      isCredit ? "CREDIT_NOTE_ISSUED" : "INVOICE_ISSUED",
      `${isCredit ? "Credit note" : "Invoice"} ${number} issued (${formatMoney(issuedView.total_incl_vat, "EN")})`,
      actorId,
      {
        metadata: {
          project_id: invoice.project_id,
          credit_for: invoice.credit_for_id ?? null,
        },
      },
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "STATUS_CHANGE",
        entity_type: "invoice",
        entity_id: id,
        changes: {
          to: "ISSUED",
          number,
          total_incl_vat: issuedView.total_incl_vat,
        },
      },
      client,
    );

    // Once the whole budget is invoiced the project counts as invoiced
    if (!isCredit && invoice.project_id) {
      const open = await client.query(
        `
          SELECT (SELECT COUNT(*) FROM project_lines WHERE project_id = $1::uuid AND kind = 'BUDGET') AS budget_lines,
                 (SELECT COUNT(*) FROM project_lines WHERE project_id = $1::uuid AND kind = 'BUDGET' AND invoice_id IS NULL) AS uninvoiced
        `,
        [invoice.project_id],
      );
      if (
        Number(open.rows[0].budget_lines) > 0 &&
        Number(open.rows[0].uninvoiced) === 0
      ) {
        await ProjectService.moveToInvoicedFromInvoice(
          client,
          invoice.project_id,
          actorId,
        );
      }
    }

    return { creditFor: isCredit ? (invoice.credit_for_id as string) : null };
  });

  // A credit that settles an invoice makes its open payment links pointless
  if (issued.creditFor) {
    await InvoicePaymentService.cancelOpenLinksIfSettled(issued.creditFor);
  }

  // Every issued invoice and credit note goes to SnelStart (when the integration is on)
  await enqueueSnelStart("SALES_INVOICE", id, actorId);

  const result: any = await readInvoice(id);
  if (input.send) {
    // Issued is issued: a failure to send does not undo it
    try {
      const sent = await InvoiceDeliveryService.sendInvoice(
        id,
        input.email,
        actorId,
      );
      result.delivery = { sent: true, to: sent.sent_to };
    } catch (error: any) {
      result.delivery = {
        sent: false,
        error: error?.message ?? "Sending failed",
      };
    }
    const fresh = await readInvoice(id);
    return { ...fresh, delivery: result.delivery };
  }
  return result;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const getInvoiceById = (id: string) => readInvoice(id);

const outstandingSql = `
  CASE WHEN i.status = 'ISSUED' AND i.kind <> 'CREDIT_NOTE'
       THEN GREATEST(0, ROUND((i.total_incl_vat - i.credited_amount - i.paid_amount) * 100)) / 100.0
       ELSE NULL END
`;

const getAllInvoices = async (params: Record<string, any>) => {
  const { page, limit, skip, sortBy, sortOrder } =
    paginationHelper.calculatePagination(params as any);

  const sortable: Record<string, string> = {
    created_at: "i.created_at",
    number: "i.number",
    invoice_date: "i.invoice_date",
    due_date: "i.due_date",
    total: "i.total_incl_vat",
    customer: "LOWER(i.customer_name)",
  };
  const orderColumn = sortable[sortBy] ?? "i.created_at";
  const orderDirection = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  const conditions: string[] = [];
  const values: any[] = [];
  let n = 1;

  if (params.searchTerm) {
    const term = String(
      Array.isArray(params.searchTerm)
        ? params.searchTerm[0]
        : params.searchTerm,
    )
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(
      `(i.number ILIKE $${n} OR i.title ILIKE $${n} OR i.customer_name ILIKE $${n} OR r.name ILIKE $${n} OR p.number ILIKE $${n} OR i.recipient_email ILIKE $${n})`,
    );
    values.push(`%${term}%`);
    n++;
  }
  if (params.kind) {
    const kinds = asList(params.kind).map((k) => k.toUpperCase());
    if (kinds.some((k) => !(invoiceKinds as readonly string[]).includes(k))) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Kind should be STANDARD, INSTALMENT, FINAL or CREDIT_NOTE!",
      );
    }
    conditions.push(`i.kind = ANY($${n++}::"InvoiceKind"[])`);
    values.push(kinds);
  }
  if (params.status) {
    const statuses = asList(params.status).map((s) => s.toUpperCase());
    if (
      statuses.some((s) => !(invoiceStatuses as readonly string[]).includes(s))
    ) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Status should be DRAFT or ISSUED!",
      );
    }
    conditions.push(`i.status = ANY($${n++}::"InvoiceStatus"[])`);
    values.push(statuses);
  }
  if (params.payment_status) {
    const statuses = asList(params.payment_status).map((s) => s.toUpperCase());
    if (
      statuses.some((s) => !(paymentStatuses as readonly string[]).includes(s))
    ) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Payment status should be OPEN, PARTIALLY_PAID, PAID or CREDITED!",
      );
    }
    conditions.push(`i.payment_status = ANY($${n++}::"InvoicePaymentStatus"[])`);
    values.push(statuses);
  }
  for (const [param, column, label] of [
    ["relation_id", "i.relation_id", "relation id"],
    ["project_id", "i.project_id", "project id"],
    ["credit_for_id", "i.credit_for_id", "invoice id"],
  ] as const) {
    if (params[param]) {
      assertUuid(String(params[param]), label);
      conditions.push(`${column} = $${n++}::uuid`);
      values.push(String(params[param]));
    }
  }
  if (String(params.overdue) === "true") {
    conditions.push(
      `(i.status = 'ISSUED' AND i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID') AND i.due_date < ${todaySql})`,
    );
  }
  for (const [param, column, operator] of [
    ["issued_from", "i.invoice_date", ">="],
    ["issued_to", "i.invoice_date", "<="],
    ["due_from", "i.due_date", ">="],
    ["due_to", "i.due_date", "<="],
  ] as const) {
    if (params[param]) {
      conditions.push(`${column} ${operator} $${n++}::date`);
      values.push(assertDay(params[param], param));
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `
    FROM invoices i
    JOIN relations r ON r.id = i.relation_id
    LEFT JOIN projects p ON p.id = i.project_id
    ${where}
  `;

  const [result, totals] = await Promise.all([
    query(
      `
        SELECT i.id, i.number, i.kind, i.status, i.payment_status, i.title,
               i.customer_name, i.total_excl_vat::float8 AS total_excl_vat, i.total_incl_vat::float8 AS total_incl_vat,
               ${outstandingSql}::float8 AS amount_outstanding,
               to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
               (i.status = 'ISSUED' AND i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID') AND i.due_date < ${todaySql}) AS is_overdue,
               i.sent_at, i.created_at AS "createdAt",
               json_build_object('id', r.id, 'name', r.name) AS relation,
               CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'number', p.number) END AS project
        ${from}
        ORDER BY ${orderColumn} ${orderDirection} NULLS LAST, i.id ASC
        LIMIT $${n} OFFSET $${n + 1}
      `,
      [...values, limit, skip],
    ),
    query(
      `
        SELECT COUNT(*)::int AS total,
               COALESCE(SUM(i.total_incl_vat), 0)::float8 AS amount,
               COALESCE(SUM(${outstandingSql}), 0)::float8 AS outstanding
        ${from}
      `,
      values,
    ),
  ]);

  const total = totals.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    totals: {
      invoices: total,
      total_incl_vat: round2(totals.rows[0].amount),
      outstanding: round2(totals.rows[0].outstanding),
    },
    meta: {
      page,
      limit,
      total,
      totalPage,
      hasNextPage: page < totalPage,
      hasPrevPage: page > 1,
    },
  };
};

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

// The PDF of an issued invoice is served as it was issued. A draft gets a preview.
const getPdf = async (id: string) => {
  assertUuid(id, "invoice id");
  const found = await query(
    `SELECT id, number, status, pdf_data FROM invoices WHERE id = $1::uuid`,
    [id],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Invoice not found!");
  }
  const row = found.rows[0];
  if (row.status === "ISSUED" && row.pdf_data) {
    return { pdf: row.pdf_data as Buffer, filename: `${row.number}.pdf` };
  }
  if (row.status === "ISSUED") {
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "The PDF of this invoice is missing.",
    );
  }

  const company = await SettingsService.getCompanySettings();
  const logo = await loadLogo(company.logo_url);
  const draft = await readInvoice(id);
  const language = toLanguage(draft.language);
  const pdf = await buildInvoicePdf(
    pdfInput(draft, "DRAFT", true, company, language),
    company,
    language,
    { logo },
  );
  return { pdf, filename: "invoice-draft.pdf" };
};

// ---------------------------------------------------------------------------
// Overview with ageing (FR-INV-13)
// ---------------------------------------------------------------------------

// What is still to be paid, split into "not due yet" and overdue, the overdue part by the
// number of days past the due date: 1-30, 31-60 and 61+.
const getOverview = async () => {
  const result = await query(
    `
      WITH open AS (
        SELECT i.id, i.relation_id,
               GREATEST(0, ROUND((i.total_incl_vat - i.credited_amount - i.paid_amount) * 100)) AS cents,
               (${todaySql} - i.due_date) AS days_past_due
        FROM invoices i
        WHERE i.status = 'ISSUED' AND i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID')
      )
      SELECT
        COUNT(*) FILTER (WHERE cents > 0)::int AS open_count,
        COALESCE(SUM(cents), 0)::float8 AS open_cents,
        COUNT(*) FILTER (WHERE cents > 0 AND days_past_due <= 0)::int AS current_count,
        COALESCE(SUM(cents) FILTER (WHERE days_past_due <= 0), 0)::float8 AS current_cents,
        COUNT(*) FILTER (WHERE cents > 0 AND days_past_due BETWEEN 1 AND 30)::int AS a_count,
        COALESCE(SUM(cents) FILTER (WHERE days_past_due BETWEEN 1 AND 30), 0)::float8 AS a_cents,
        COUNT(*) FILTER (WHERE cents > 0 AND days_past_due BETWEEN 31 AND 60)::int AS b_count,
        COALESCE(SUM(cents) FILTER (WHERE days_past_due BETWEEN 31 AND 60), 0)::float8 AS b_cents,
        COUNT(*) FILTER (WHERE cents > 0 AND days_past_due >= 61)::int AS c_count,
        COALESCE(SUM(cents) FILTER (WHERE days_past_due >= 61), 0)::float8 AS c_cents
      FROM open
    `,
  );
  const r = result.rows[0];
  const amount = (cents: number) => fromCents(Math.round(cents));
  const overdueCount = r.a_count + r.b_count + r.c_count;
  const overdueCents = r.a_cents + r.b_cents + r.c_cents;

  const oldest = await query(
    `
      SELECT i.id, i.number, i.customer_name, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, (${todaySql} - i.due_date) AS days_overdue,
             ${outstandingSql}::float8 AS amount_outstanding
      FROM invoices i
      WHERE i.status = 'ISSUED' AND i.kind <> 'CREDIT_NOTE' AND i.payment_status IN ('OPEN', 'PARTIALLY_PAID') AND i.due_date < ${todaySql}
      ORDER BY i.due_date ASC LIMIT 10
    `,
  );

  return {
    open: { invoices: r.open_count, amount: amount(r.open_cents) },
    not_yet_due: { invoices: r.current_count, amount: amount(r.current_cents) },
    overdue: { invoices: overdueCount, amount: amount(overdueCents) },
    ageing: [
      {
        bucket: "1-30",
        label: "1 to 30 days overdue",
        invoices: r.a_count,
        amount: amount(r.a_cents),
      },
      {
        bucket: "31-60",
        label: "31 to 60 days overdue",
        invoices: r.b_count,
        amount: amount(r.b_cents),
      },
      {
        bucket: "61+",
        label: "61 or more days overdue",
        invoices: r.c_count,
        amount: amount(r.c_cents),
      },
    ],
    oldest_overdue: oldest.rows,
  };
};

// ---------------------------------------------------------------------------
// Export (FR-INV-12)
// ---------------------------------------------------------------------------

const exportRange = (params: Record<string, any>) => {
  if (!params.from || !params.to) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "from and to are required (e.g. from=2026-11-01&to=2026-11-30)!",
    );
  }
  const from = assertDay(params.from, "from");
  const to = assertDay(params.to, "to");
  if (to < from) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "The end of the period cannot be before its start!",
    );
  }
  const days =
    Math.round(
      (new Date(`${to}T12:00:00Z`).getTime() -
        new Date(`${from}T12:00:00Z`).getTime()) /
        86_400_000,
    ) + 1;
  if (days > MAX_EXPORT_DAYS) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `A period can be at most ${MAX_EXPORT_DAYS} days!`,
    );
  }
  return { from, to };
};

// A list of the issued invoices and credit notes of a period (by invoice date)
const exportCsv = async (params: Record<string, any>) => {
  const { from, to } = exportRange(params);
  const delimiter = csvDelimiter(params.delimiter);

  const result = await query(
    `
      SELECT i.number, i.kind, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
             i.customer_name, i.customer_vat_number, p.number AS project_number, i.title,
             i.total_excl_vat::float8 AS excl, i.total_vat::float8 AS vat, i.total_incl_vat::float8 AS incl,
             i.paid_amount::float8 AS paid, i.credited_amount::float8 AS credited,
             ${outstandingSql}::float8 AS outstanding, i.payment_status, to_char(i.sent_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD') AS sent_on,
             c.number AS credit_for
      FROM invoices i
      LEFT JOIN projects p ON p.id = i.project_id
      LEFT JOIN invoices c ON c.id = i.credit_for_id
      WHERE i.status = 'ISSUED' AND i.invoice_date BETWEEN $1::date AND $2::date
      ORDER BY i.invoice_date ASC, i.number ASC
    `,
    [from, to],
  );

  const money = (value: number | null) =>
    value === null ? "" : csvAmount(value, delimiter);
  const rows: any[][] = [
    [
      "Number",
      "Type",
      "Invoice date",
      "Due date",
      "Customer",
      "Customer VAT number",
      "Project",
      "Title",
      "Excl. VAT",
      "VAT",
      "Incl. VAT",
      "Paid",
      "Credited",
      "Outstanding",
      "Payment status",
      "Sent on",
      "Credit for",
    ],
    ...result.rows.map((r: any) => [
      r.number,
      r.kind,
      r.invoice_date,
      r.due_date,
      r.customer_name,
      r.customer_vat_number,
      r.project_number,
      r.title,
      money(r.excl),
      money(r.vat),
      money(r.incl),
      money(r.kind === "CREDIT_NOTE" ? null : r.paid),
      money(r.kind === "CREDIT_NOTE" ? null : r.credited),
      money(r.outstanding),
      r.payment_status,
      r.sent_on,
      r.credit_for,
    ]),
  ];
  return {
    csv: buildCsv(rows, delimiter),
    filename: `invoices_${from}_${to}.csv`,
  };
};

// The PDFs of the same invoices in one ZIP, as they were issued
const exportPdfBundle = async (params: Record<string, any>) => {
  const { from, to } = exportRange(params);
  const result = await query(
    `
      SELECT number, pdf_data FROM invoices
      WHERE status = 'ISSUED' AND invoice_date BETWEEN $1::date AND $2::date AND pdf_data IS NOT NULL
      ORDER BY invoice_date ASC, number ASC
      LIMIT $3
    `,
    [from, to, MAX_EXPORT_INVOICES + 1],
  );
  if (result.rows.length > MAX_EXPORT_INVOICES) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `That is more than ${MAX_EXPORT_INVOICES} invoices. Choose a shorter period!`,
    );
  }
  if (result.rows.length === 0) {
    throw new ApiError(
      httpStatus.NOT_FOUND,
      "There are no invoices in this period!",
    );
  }
  const zip = createZip(
    result.rows.map((r: any) => ({
      name: `${r.number}.pdf`,
      data: r.pdf_data as Buffer,
    })),
  );
  return { zip, filename: `invoices_${from}_${to}.zip` };
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const getHistory = async (id: string, params: Record<string, any>) => {
  assertUuid(id, "invoice id");
  const exists = await query(`SELECT 1 FROM invoices WHERE id = $1::uuid`, [
    id,
  ]);
  if (exists.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Invoice not found!");
  }

  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );
  const scope = `t.entity_type = 'invoice' AND t.entity_id = $1::uuid`;

  const [result, count] = await Promise.all([
    query(
      `
        SELECT t.id, t.event_type, t.entity_id, t.title, t.description, t.metadata, t.actor_id,
               u.name AS actor_name, t.created_at AS "createdAt"
        FROM relation_timeline t LEFT JOIN users u ON u.id = t.actor_id
        WHERE ${scope}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $2 OFFSET $3
      `,
      [id, limit, skip],
    ),
    query(`SELECT COUNT(*) AS total FROM relation_timeline t WHERE ${scope}`, [
      id,
    ]),
  ]);

  const total = parseInt(count.rows[0].total);
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    meta: {
      page,
      limit,
      total,
      totalPage,
      hasNextPage: page < totalPage,
      hasPrevPage: page > 1,
    },
  };
};

void invoiceColumns;
void invoiceJoins;

export const InvoiceService = {
  createInvoice,
  updateInvoice,
  setItems,
  deleteInvoice,
  createCreditNote,
  issueInvoice,
  getInvoiceById,
  getAllInvoices,
  getPdf,
  getOverview,
  exportCsv,
  exportPdfBundle,
  getHistory,
};
