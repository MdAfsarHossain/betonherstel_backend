import {
  buildPdf,
  companyFooterLine,
  drawLetterhead,
  drawTable,
  ICompanyDetails,
  PDF_COLORS,
  PDF_MARGIN,
} from "../../lib/pdfService";
import { formatDate, formatMoney } from "../../utils/formatters";
import { t, TLanguage, TTranslationKey } from "../../utils/i18n";

// The branded customer PDF of a quotation (FR-QUO-08). It shows prices and VAT
// only: cost prices, margins and internal notes never appear here (FR-QUO-04).

const locales: Record<TLanguage, string> = { NL: "nl-NL", EN: "en-GB" };

// 12 / 12,5 / 0,333, never more than 3 decimals and no trailing zeros
const formatQuantity = (quantity: number, language: TLanguage) =>
  new Intl.NumberFormat(locales[language], { maximumFractionDigits: 3 }).format(quantity);

const formatRate = (rate: number, language: TLanguage) =>
  `${new Intl.NumberFormat(locales[language], { maximumFractionDigits: 2 }).format(rate)}%`;

export interface IQuotePdfInput {
  number: string;
  revision: number;
  title: string;
  valid_until: string; // YYYY-MM-DD
  intro_text?: string | null;
  scope_text?: string | null;
  conditions_text?: string | null;
  warranty_text?: string | null;
  recipient_name?: string | null;
  relation: {
    name: string;
    billing_street?: string | null;
    billing_house_number?: string | null;
    billing_postcode?: string | null;
    billing_city?: string | null;
  };
  street?: string | null;
  house_number?: string | null;
  postcode?: string | null;
  city?: string | null;
  sections: {
    title: string | null;
    lines: {
      description: string;
      quantity: number;
      unit: string;
      unit_price: number;
      vat_rate: number;
      vat_reverse_charge: boolean;
      line_total: number;
    }[];
  }[];
  vat: { code: string; rate: number; reverse_charge: boolean; base: number; vat: number }[];
  total_excl_vat: number;
  total_incl_vat: number;
}

const addressLines = (street?: string | null, houseNumber?: string | null, postcode?: string | null, city?: string | null) =>
  [[street, houseNumber].filter(Boolean).join(" "), [postcode, city].filter(Boolean).join(" ")].filter(Boolean);

export const buildQuotePdf = (
  quote: IQuotePdfInput,
  company: ICompanyDetails,
  language: TLanguage,
  options: { logo?: Buffer | null; isDraft: boolean; issueDate: Date },
) =>
  buildPdf(
    (doc) => {
      const left = PDF_MARGIN;
      const contentWidth = doc.page.width - PDF_MARGIN * 2;
      const { text, muted, line } = PDF_COLORS;

      // Starts a new page when fewer than `needed` points are left
      const ensureSpace = (needed: number) => {
        if (doc.y + needed > doc.page.height - PDF_MARGIN - 30) {
          doc.addPage();
          doc.x = left;
          doc.y = PDF_MARGIN;
        }
      };

      const paragraph = (heading: string, body?: string | null) => {
        if (!body || !body.trim()) return;
        ensureSpace(60);
        doc.font("Helvetica-Bold").fontSize(11).fillColor(text).text(heading, left, doc.y, { width: contentWidth });
        doc.moveDown(0.3);
        doc.font("Helvetica").fontSize(9.5).fillColor(text).text(body.trim(), left, doc.y, { width: contentWidth });
        doc.moveDown(1);
      };

      drawLetterhead(doc, company, language, options.logo);

      // Title and number
      doc.font("Helvetica-Bold").fontSize(20).fillColor(text).text(t(language, "quote_title"), left, doc.y);
      const numberText =
        quote.revision > 1
          ? `${quote.number} (${t(language, "quote_revision")} ${quote.revision})`
          : quote.number;
      doc.font("Helvetica").fontSize(10).fillColor(muted).text(numberText, left, doc.y);
      if (options.isDraft) {
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#dc2626").text(t(language, "quote_draft"), left, doc.y);
      }
      doc.moveDown(0.8);

      // Customer on the left, dates and work address on the right
      const top = doc.y;
      const rightX = left + 300;
      const rightWidth = contentWidth - 300;

      const column = (x: number, width: number, rows: { label?: string; value: string; bold?: boolean }[]) => {
        let y = top;
        for (const row of rows) {
          if (row.label) {
            doc.font("Helvetica").fontSize(8).fillColor(muted).text(row.label.toUpperCase(), x, y, { width });
            y = doc.y + 1;
          }
          doc.font(row.bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(text).text(row.value, x, y, { width });
          y = doc.y + 4;
        }
        return y;
      };

      const billTo = addressLines(
        quote.relation.billing_street,
        quote.relation.billing_house_number,
        quote.relation.billing_postcode,
        quote.relation.billing_city,
      );
      const objectLines = addressLines(quote.street, quote.house_number, quote.postcode, quote.city);

      const leftRows = [
        { label: t(language, "quote_to"), value: quote.relation.name, bold: true },
        ...(quote.recipient_name && quote.recipient_name !== quote.relation.name
          ? [{ value: `${t(language, "quote_attn")} ${quote.recipient_name}` }]
          : []),
        ...billTo.map((value) => ({ value })),
      ];
      const rightRows = [
        { label: t(language, "date"), value: formatDate(options.issueDate, language) },
        { label: t(language, "quote_valid_until"), value: formatDate(`${quote.valid_until}T12:00:00Z`, language) },
        ...(objectLines.length ? [{ label: t(language, "quote_object_address"), value: objectLines.join(", ") }] : []),
      ];

      const leftEnd = column(left, 280, leftRows);
      const rightEnd = column(rightX, rightWidth, rightRows);
      doc.x = left;
      doc.y = Math.max(leftEnd, rightEnd) + 12;

      doc.font("Helvetica-Bold").fontSize(12).fillColor(text).text(quote.title, left, doc.y, { width: contentWidth });
      doc.moveDown(0.6);

      if (quote.intro_text?.trim()) {
        doc.font("Helvetica").fontSize(9.5).fillColor(text).text(quote.intro_text.trim(), left, doc.y, { width: contentWidth });
        doc.moveDown(1);
      }

      // Sections with their lines (A4 content width is 495)
      const columns = [
        { header: t(language, "description"), key: "description", width: 235 },
        { header: t(language, "quantity"), key: "quantity", width: 70, align: "right" as const },
        { header: t(language, "unit_price"), key: "price", width: 70, align: "right" as const },
        { header: t(language, "vat"), key: "vat", width: 45, align: "right" as const },
        { header: t(language, "total"), key: "total", width: 75, align: "right" as const },
      ];

      for (const section of quote.sections) {
        ensureSpace(70);
        if (section.title?.trim()) {
          doc.font("Helvetica-Bold").fontSize(10.5).fillColor(text).text(section.title.trim(), left, doc.y, { width: contentWidth });
          doc.moveDown(0.3);
        }
        drawTable(
          doc,
          columns,
          section.lines.map((l) => ({
            description: l.description,
            quantity: `${formatQuantity(l.quantity, language)} ${t(language, `unit_${l.unit}` as TTranslationKey)}`,
            price: formatMoney(l.unit_price, language),
            vat: l.vat_reverse_charge ? "0%" : formatRate(l.vat_rate, language),
            total: formatMoney(l.line_total, language),
          })),
        );
        doc.moveDown(0.8);
      }

      // Totals: subtotal, VAT per rate, total
      const reverse = quote.vat.some((g) => g.reverse_charge);
      ensureSpace(40 + quote.vat.length * 16 + (reverse ? 20 : 0));
      const labelX = left + 230;
      const labelWidth = 190;
      const amountX = left + 420;
      const amountWidth = contentWidth - 420;

      const totalRow = (label: string, amount: number, bold = false) => {
        const y = doc.y;
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9.5).fillColor(text);
        doc.text(label, labelX, y, { width: labelWidth, align: "right", lineBreak: false });
        doc.text(formatMoney(amount, language), amountX, y, { width: amountWidth, align: "right", lineBreak: false });
        doc.y = y + (bold ? 17 : 14);
      };

      totalRow(t(language, "subtotal_excl_vat"), quote.total_excl_vat);
      for (const g of quote.vat) {
        const label = g.reverse_charge
          ? `${t(language, "vat")} ${language === "NL" ? "verlegd" : "reverse-charged"} ${t(language, "vat_over")} ${formatMoney(g.base, language)}`
          : `${t(language, "vat")} ${formatRate(g.rate, language)} ${t(language, "vat_over")} ${formatMoney(g.base, language)}`;
        totalRow(label, g.vat);
      }
      doc.moveTo(labelX, doc.y + 1).lineTo(left + contentWidth, doc.y + 1).strokeColor(line).lineWidth(0.7).stroke();
      doc.y += 5;
      totalRow(t(language, "total_incl_vat"), quote.total_incl_vat, true);
      doc.x = left;

      if (reverse) {
        doc.moveDown(0.4);
        doc.font("Helvetica").fontSize(8.5).fillColor(muted).text(t(language, "reverse_charge_note"), left, doc.y, { width: contentWidth });
      }
      doc.moveDown(1.5);

      paragraph(t(language, "quote_scope"), quote.scope_text);
      paragraph(t(language, "quote_conditions"), quote.conditions_text);
      paragraph(t(language, "quote_warranty"), quote.warranty_text);
    },
    {
      title: `${t(language, "quote_title")} ${quote.number}`,
      language,
      footerText: companyFooterLine(company, language),
    },
  );
