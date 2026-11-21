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

// The purchase order we send to a supplier (FR-PUR-02): what we order, at what price, where
// it must be delivered and when. Internal notes never appear on it.

const locales: Record<TLanguage, string> = { NL: "nl-NL", EN: "en-GB" };

const formatQuantity = (quantity: number, language: TLanguage) =>
  new Intl.NumberFormat(locales[language], { maximumFractionDigits: 3 }).format(quantity);

const formatRate = (rate: number, language: TLanguage) =>
  `${new Intl.NumberFormat(locales[language], { maximumFractionDigits: 2 }).format(rate)}%`;

export interface IPurchaseOrderPdfInput {
  number: string;
  order_date: string; // YYYY-MM-DD
  title?: string | null;
  supplier_reference?: string | null;
  expected_delivery_date?: string | null;
  supplier: { name: string; contact_name?: string | null };
  project?: { number: string; title: string } | null;
  delivery_lines: string[];
  notes?: string | null;
  lines: { description: string; quantity: number; unit: string; unit_price: number; vat_rate: number; vat_reverse_charge: boolean; line_total: number }[];
  vat: { code: string; rate: number; reverse_charge: boolean; base: number; vat: number }[];
  total_excl_vat: number;
  total_incl_vat: number;
}

export const buildPurchaseOrderPdf = (
  po: IPurchaseOrderPdfInput,
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

      drawLetterhead(doc, company, language, options.logo);

      doc.font("Helvetica-Bold").fontSize(20).fillColor(text).text(t(language, "po_title"), left, doc.y);
      doc.font("Helvetica").fontSize(10).fillColor(muted).text(po.number, left, doc.y);
      doc.moveDown(0.8);

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

      const leftEnd = column(left, 270, [
        { label: t(language, "po_supplier"), value: po.supplier.name, bold: true },
        ...(po.supplier.contact_name ? [{ value: `${t(language, "quote_attn")} ${po.supplier.contact_name}` }] : []),
        ...(po.delivery_lines.length ? [{ label: t(language, "po_deliver_to"), value: po.delivery_lines.join("\n") }] : []),
      ]);
      const rightEnd = column(rightX, rightWidth, [
        { label: t(language, "po_number"), value: po.number, bold: true },
        { label: t(language, "po_date"), value: formatDate(`${po.order_date}T12:00:00Z`, language) },
        ...(po.expected_delivery_date ? [{ label: t(language, "po_expected"), value: formatDate(`${po.expected_delivery_date}T12:00:00Z`, language) }] : []),
        ...(po.project ? [{ label: t(language, "po_project"), value: `${po.project.number} - ${po.project.title}` }] : []),
        ...(po.supplier_reference ? [{ label: t(language, "po_reference"), value: po.supplier_reference }] : []),
      ]);
      doc.x = left;
      doc.y = Math.max(leftEnd, rightEnd) + 12;

      if (po.title?.trim()) {
        doc.font("Helvetica-Bold").fontSize(12).fillColor(text).text(po.title.trim(), left, doc.y, { width: contentWidth });
        doc.moveDown(0.6);
      }

      drawTable(
        doc,
        [
          { header: t(language, "description"), key: "description", width: 235 },
          { header: t(language, "quantity"), key: "quantity", width: 70, align: "right" },
          { header: t(language, "unit_price"), key: "price", width: 70, align: "right" },
          { header: t(language, "vat"), key: "vat", width: 45, align: "right" },
          { header: t(language, "total"), key: "total", width: 75, align: "right" },
        ],
        po.lines.map((l) => ({
          description: l.description,
          quantity: `${formatQuantity(l.quantity, language)} ${t(language, `unit_${l.unit}` as TTranslationKey)}`,
          price: formatMoney(l.unit_price, language),
          vat: l.vat_reverse_charge ? "0%" : formatRate(l.vat_rate, language),
          total: formatMoney(l.line_total, language),
        })),
      );
      doc.moveDown(0.8);

      const reverse = po.vat.some((g) => g.reverse_charge);
      ensureSpace(60 + po.vat.length * 16 + (reverse ? 20 : 0));
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

      totalRow(t(language, "subtotal_excl_vat"), po.total_excl_vat);
      for (const g of po.vat) {
        totalRow(
          g.reverse_charge
            ? `${t(language, "vat")} ${language === "NL" ? "verlegd" : "reverse-charged"} ${t(language, "vat_over")} ${formatMoney(g.base, language)}`
            : `${t(language, "vat")} ${formatRate(g.rate, language)} ${t(language, "vat_over")} ${formatMoney(g.base, language)}`,
          g.vat,
        );
      }
      doc.moveTo(labelX, doc.y + 1).lineTo(left + contentWidth, doc.y + 1).strokeColor(line).lineWidth(0.7).stroke();
      doc.y += 5;
      totalRow(t(language, "total_incl_vat"), po.total_incl_vat, true);
      doc.x = left;
      doc.moveDown(1.2);

      if (po.notes?.trim()) {
        ensureSpace(50);
        doc.font("Helvetica-Bold").fontSize(11).fillColor(text).text(t(language, "po_notes"), left, doc.y, { width: contentWidth });
        doc.moveDown(0.3);
        doc.font("Helvetica").fontSize(9.5).fillColor(text).text(po.notes.trim(), left, doc.y, { width: contentWidth });
        doc.moveDown(1);
      }
      ensureSpace(30);
      doc.font("Helvetica").fontSize(9.5).fillColor(muted).text(t(language, "po_confirm"), left, doc.y, { width: contentWidth });
    },
    { title: `${t(language, "po_title")} ${po.number}`, language, footerText: companyFooterLine(company, language) },
  );
