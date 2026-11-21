import { buildPdf, companyFooterLine, drawLetterhead, ICompanyDetails, PDF_COLORS, PDF_MARGIN } from "../../lib/pdfService";
import { formatDate, formatMoney } from "../../utils/formatters";
import { t, TLanguage } from "../../utils/i18n";

// The work instruction we send to a subcontractor (FR-SUB-02): what to do, where, when and for
// what price. It never shows the customer's price, the main quotation, our margin or internal notes.

export interface IAssignmentPdfInput {
  number: string;
  title: string;
  subcontractor: { name: string; contact_name?: string | null };
  project: { number: string; title: string };
  address_lines: string[];
  planned_start?: string | null; // YYYY-MM-DD
  planned_end?: string | null;
  scope_description: string;
  agreed_price_excl_vat: number;
  vat_reverse_charge: boolean;
}

export const buildAssignmentPdf = (
  a: IAssignmentPdfInput,
  company: ICompanyDetails,
  language: TLanguage,
  options: { logo?: Buffer | null },
) =>
  buildPdf(
    (doc) => {
      const left = PDF_MARGIN;
      const contentWidth = doc.page.width - PDF_MARGIN * 2;
      const { text, muted } = PDF_COLORS;

      const ensureSpace = (needed: number) => {
        if (doc.y + needed > doc.page.height - PDF_MARGIN - 30) {
          doc.addPage();
          doc.x = left;
          doc.y = PDF_MARGIN;
        }
      };

      drawLetterhead(doc, company, language, options.logo);

      doc.font("Helvetica-Bold").fontSize(20).fillColor(text).text(t(language, "sa_title"), left, doc.y);
      doc.font("Helvetica").fontSize(10).fillColor(muted).text(a.number, left, doc.y);
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

      const period =
        a.planned_start && a.planned_end
          ? `${formatDate(`${a.planned_start}T12:00:00Z`, language)} ${t(language, "sa_to")} ${formatDate(`${a.planned_end}T12:00:00Z`, language)}`
          : a.planned_start
            ? formatDate(`${a.planned_start}T12:00:00Z`, language)
            : a.planned_end
              ? formatDate(`${a.planned_end}T12:00:00Z`, language)
              : null;

      const leftEnd = column(left, 270, [
        { label: t(language, "sa_subcontractor"), value: a.subcontractor.name, bold: true },
        ...(a.subcontractor.contact_name ? [{ value: `${t(language, "quote_attn")} ${a.subcontractor.contact_name}` }] : []),
        ...(a.address_lines.length ? [{ label: t(language, "sa_location"), value: a.address_lines.join("\n") }] : []),
      ]);
      const rightEnd = column(rightX, rightWidth, [
        { label: t(language, "sa_number"), value: a.number, bold: true },
        { label: t(language, "sa_project"), value: `${a.project.number} - ${a.project.title}` },
        ...(period ? [{ label: t(language, "sa_period"), value: period }] : []),
      ]);
      doc.x = left;
      doc.y = Math.max(leftEnd, rightEnd) + 12;

      doc.font("Helvetica-Bold").fontSize(12).fillColor(text).text(a.title, left, doc.y, { width: contentWidth });
      doc.moveDown(0.8);

      ensureSpace(60);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(text).text(t(language, "sa_scope"), left, doc.y, { width: contentWidth });
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(9.5).fillColor(text).text(a.scope_description, left, doc.y, { width: contentWidth });
      doc.moveDown(1);

      ensureSpace(60);
      doc.font("Helvetica").fontSize(8).fillColor(muted).text(t(language, "sa_price").toUpperCase(), left, doc.y, { width: contentWidth });
      doc.font("Helvetica-Bold").fontSize(14).fillColor(text).text(formatMoney(a.agreed_price_excl_vat, language), left, doc.y + 1, { width: contentWidth });
      if (a.vat_reverse_charge) {
        doc.moveDown(0.3);
        doc.font("Helvetica").fontSize(9.5).fillColor(muted).text(t(language, "sa_reverse"), left, doc.y, { width: contentWidth });
      }
      doc.moveDown(1.2);

      ensureSpace(30);
      doc.font("Helvetica").fontSize(9.5).fillColor(muted).text(t(language, "sa_confirm"), left, doc.y, { width: contentWidth });
    },
    { title: `${t(language, "sa_title")} ${a.number}`, language, footerText: companyFooterLine(company, language) },
  );
