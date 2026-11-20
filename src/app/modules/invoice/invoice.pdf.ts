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

// The branded PDF of an invoice or credit note (FR-INV-07). It carries what a Dutch invoice
// must show (FR-INV-05): the company's and the customer's details with KvK and VAT numbers,
// the invoice date and number, the lines, VAT per rate, the totals and, where it applies,
// the reverse-charge statement. No cost prices, margins or internal notes ever appear here.

const locales: Record<TLanguage, string> = { NL: "nl-NL", EN: "en-GB" };

const formatQuantity = (quantity: number, language: TLanguage) =>
  new Intl.NumberFormat(locales[language], { maximumFractionDigits: 3 }).format(quantity);

const formatRate = (rate: number, language: TLanguage) =>
  `${new Intl.NumberFormat(locales[language], { maximumFractionDigits: 2 }).format(rate)}%`;

export interface IInvoicePdfInput {
  number: string;
  is_credit_note: boolean;
  invoice_date: string; // YYYY-MM-DD
  due_date: string | null;
  title?: string | null;
  intro_text?: string | null;
  footer_text?: string | null;
  customer: {
    name: string;
    recipient_name?: string | null;
    street?: string | null;
    house_number?: string | null;
    postcode?: string | null;
    city?: string | null;
    vat_number?: string | null;
    kvk_number?: string | null;
  };
  project?: { number: string; title: string } | null;
  original_number?: string | null;
  reason?: string | null;
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
  bank: { iban?: string | null; bic?: string | null; bank_name?: string | null };
}

const addressLines = (street?: string | null, houseNumber?: string | null, postcode?: string | null, city?: string | null) =>
  [[street, houseNumber].filter(Boolean).join(" "), [postcode, city].filter(Boolean).join(" ")].filter(Boolean);

export const buildInvoicePdf = (
  invoice: IInvoicePdfInput,
  company: ICompanyDetails,
  language: TLanguage,
  options: { logo?: Buffer | null },
) =>
  buildPdf(
    (doc) => {
      const left = PDF_MARGIN;
      const contentWidth = doc.page.width - PDF_MARGIN * 2;
      const { text, muted, line } = PDF_COLORS;

      const ensureSpace = (needed: number) => {
        if (doc.y + needed > doc.page.height - PDF_MARGIN - 30) {
          doc.addPage();
          doc.x = left;
          doc.y = PDF_MARGIN;
        }
      };

      const paragraph = (heading: string | null, body?: string | null) => {
        if (!body || !body.trim()) return;
        ensureSpace(50);
        if (heading) {
          doc.font("Helvetica-Bold").fontSize(11).fillColor(text).text(heading, left, doc.y, { width: contentWidth });
          doc.moveDown(0.3);
        }
        doc.font("Helvetica").fontSize(9.5).fillColor(text).text(body.trim(), left, doc.y, { width: contentWidth });
        doc.moveDown(1);
      };

      drawLetterhead(doc, company, language, options.logo);

      doc
        .font("Helvetica-Bold")
        .fontSize(20)
        .fillColor(text)
        .text(t(language, invoice.is_credit_note ? "inv_credit_title" : "inv_title"), left, doc.y);
      doc.font("Helvetica").fontSize(10).fillColor(muted).text(invoice.number, left, doc.y);
      doc.moveDown(0.8);

      // The customer on the left; number, dates and references on the right
      const top = doc.y;
      const rightX = left + 290;
      const rightWidth = contentWidth - 290;
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

      const c = invoice.customer;
      const leftRows = [
        { label: t(language, "inv_bill_to"), value: c.name, bold: true },
        ...(c.recipient_name && c.recipient_name !== c.name ? [{ value: `${t(language, "quote_attn")} ${c.recipient_name}` }] : []),
        ...addressLines(c.street, c.house_number, c.postcode, c.city).map((value) => ({ value })),
        ...(c.vat_number ? [{ value: `${t(language, "inv_vat_number")}: ${c.vat_number}` }] : []),
        ...(c.kvk_number ? [{ value: `${t(language, "inv_kvk")}: ${c.kvk_number}` }] : []),
      ];
      const rightRows = [
        { label: t(language, invoice.is_credit_note ? "inv_credit_number" : "inv_number"), value: invoice.number, bold: true },
        { label: t(language, "inv_date"), value: formatDate(`${invoice.invoice_date}T12:00:00Z`, language) },
        ...(invoice.due_date ? [{ label: t(language, "inv_due_date"), value: formatDate(`${invoice.due_date}T12:00:00Z`, language) }] : []),
        ...(invoice.project ? [{ label: t(language, "inv_project"), value: `${invoice.project.number} - ${invoice.project.title}` }] : []),
        ...(invoice.original_number ? [{ label: t(language, "inv_original"), value: invoice.original_number }] : []),
      ];

      const leftEnd = column(left, 270, leftRows);
      const rightEnd = column(rightX, rightWidth, rightRows);
      doc.x = left;
      doc.y = Math.max(leftEnd, rightEnd) + 12;

      if (invoice.title?.trim()) {
        doc.font("Helvetica-Bold").fontSize(12).fillColor(text).text(invoice.title.trim(), left, doc.y, { width: contentWidth });
        doc.moveDown(0.6);
      }
      if (invoice.reason?.trim()) {
        doc.font("Helvetica").fontSize(9.5).fillColor(text).text(`${t(language, "inv_reason")}: ${invoice.reason.trim()}`, left, doc.y, { width: contentWidth });
        doc.moveDown(0.8);
      }
      paragraph(null, invoice.intro_text);

      const columns = [
        { header: t(language, "description"), key: "description", width: 235 },
        { header: t(language, "quantity"), key: "quantity", width: 70, align: "right" as const },
        { header: t(language, "unit_price"), key: "price", width: 70, align: "right" as const },
        { header: t(language, "vat"), key: "vat", width: 45, align: "right" as const },
        { header: t(language, "total"), key: "total", width: 75, align: "right" as const },
      ];

      for (const section of invoice.sections) {
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
      const reverse = invoice.vat.some((g) => g.reverse_charge);
      ensureSpace(60 + invoice.vat.length * 16 + (reverse ? 20 : 0));
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

      totalRow(t(language, "subtotal_excl_vat"), invoice.total_excl_vat);
      for (const g of invoice.vat) {
        const label = g.reverse_charge
          ? `${t(language, "vat")} ${language === "NL" ? "verlegd" : "reverse-charged"} ${t(language, "vat_over")} ${formatMoney(g.base, language)}`
          : `${t(language, "vat")} ${formatRate(g.rate, language)} ${t(language, "vat_over")} ${formatMoney(g.base, language)}`;
        totalRow(label, g.vat);
      }
      doc.moveTo(labelX, doc.y + 1).lineTo(left + contentWidth, doc.y + 1).strokeColor(line).lineWidth(0.7).stroke();
      doc.y += 5;
      totalRow(t(language, "total_incl_vat"), invoice.total_incl_vat, true);
      doc.x = left;

      if (reverse) {
        doc.moveDown(0.4);
        doc.font("Helvetica").fontSize(8.5).fillColor(muted).text(t(language, "reverse_charge_note"), left, doc.y, { width: contentWidth });
      }
      doc.moveDown(1.2);

      // How to pay (not on a credit note)
      if (!invoice.is_credit_note) {
        const bankRows = [
          [t(language, "inv_amount_due"), formatMoney(invoice.total_incl_vat, language)],
          invoice.due_date ? [t(language, "inv_due_date"), formatDate(`${invoice.due_date}T12:00:00Z`, language)] : null,
          invoice.bank.iban ? [t(language, "inv_iban"), invoice.bank.iban] : null,
          invoice.bank.bic ? [t(language, "inv_bic"), invoice.bank.bic] : null,
          invoice.bank.bank_name ? [t(language, "inv_bank"), invoice.bank.bank_name] : null,
          [t(language, "inv_reference"), invoice.number],
        ].filter(Boolean) as string[][];

        ensureSpace(30 + bankRows.length * 14);
        doc.font("Helvetica-Bold").fontSize(11).fillColor(text).text(t(language, "inv_payment"), left, doc.y, { width: contentWidth });
        doc.moveDown(0.3);
        doc.font("Helvetica").fontSize(9).fillColor(muted).text(t(language, "inv_pay_before"), left, doc.y, { width: contentWidth });
        doc.moveDown(0.3);
        for (const [label, value] of bankRows) {
          const y = doc.y;
          doc.font("Helvetica").fontSize(9.5).fillColor(muted).text(label, left, y, { width: 130, lineBreak: false });
          doc.font("Helvetica-Bold").fontSize(9.5).fillColor(text).text(value, left + 135, y, { width: contentWidth - 135, lineBreak: false });
          doc.y = y + 14;
        }
        doc.x = left;
        doc.moveDown(1);
      }

      paragraph(null, invoice.footer_text);
    },
    {
      title: `${t(language, invoice.is_credit_note ? "inv_credit_title" : "inv_title")} ${invoice.number}`,
      language,
      footerText: companyFooterLine(company, language),
    },
  );
