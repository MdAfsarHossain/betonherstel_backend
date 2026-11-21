import {
  buildPdf,
  drawLetterhead,
  drawTable,
  ICompanyDetails,
  PDF_COLORS,
  PDF_MARGIN,
} from "../../lib/pdfService";
import { formatDate } from "../../utils/formatters";
import { t, TLanguage, TTranslationKey } from "../../utils/i18n";

// The customer PDF of a completed work order (FR-WO-04): what was done, the checklist,
// materials used, hours and the customer's signature. Never internal notes or the
// crew's private notes, and no prices.

const locales: Record<TLanguage, string> = { NL: "nl-NL", EN: "en-GB" };

const formatQuantity = (quantity: number | null, language: TLanguage) =>
  quantity === null ? "-" : new Intl.NumberFormat(locales[language], { maximumFractionDigits: 3 }).format(quantity);

// 90 minutes -> 1:30
export const formatDuration = (minutes: number) =>
  `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;

export interface IWorkOrderPdfInput {
  number: string;
  title: string;
  instructions?: string | null;
  planned_date?: string | null; // YYYY-MM-DD
  completed_at: Date | string;
  project: { number: string; title: string };
  customer_name: string;
  address_lines: string[];
  crew: string[];
  checklist: { text: string; is_done: boolean }[];
  materials: { description: string; unit: string; quantity_planned: number; quantity_used: number | null }[];
  work_performed?: string | null;
  hours: { employee: string; work_date: string; entry_type: string; minutes: number }[];
  photo_count: number;
  signature: { name: string; signed_at: Date | string; png: Buffer } | null;
}

export const buildWorkOrderPdf = (
  wo: IWorkOrderPdfInput,
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

      const heading = (label: string) => {
        ensureSpace(50);
        doc.font("Helvetica-Bold").fontSize(11).fillColor(text).text(label, left, doc.y, { width: contentWidth });
        doc.moveDown(0.3);
      };

      const paragraph = (label: string, body?: string | null) => {
        if (!body || !body.trim()) return;
        heading(label);
        doc.font("Helvetica").fontSize(9.5).fillColor(text).text(body.trim(), left, doc.y, { width: contentWidth });
        doc.moveDown(1);
      };

      drawLetterhead(doc, company, language, options.logo);

      doc.font("Helvetica-Bold").fontSize(20).fillColor(text).text(t(language, "wo_title"), left, doc.y);
      doc.font("Helvetica").fontSize(10).fillColor(muted).text(wo.number, left, doc.y);
      doc.moveDown(0.8);

      // Customer and project on the left, dates and address on the right
      const top = doc.y;
      const rightX = left + 270;
      const rightWidth = contentWidth - 270;
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

      const leftEnd = column(left, 250, [
        { label: t(language, "wo_customer"), value: wo.customer_name, bold: true },
        { label: t(language, "wo_project"), value: `${wo.project.number} - ${wo.project.title}` },
        ...(wo.crew.length ? [{ label: t(language, "wo_crew"), value: wo.crew.join(", ") }] : []),
      ]);
      const rightEnd = column(rightX, rightWidth, [
        ...(wo.planned_date ? [{ label: t(language, "wo_planned"), value: formatDate(`${wo.planned_date}T12:00:00Z`, language) }] : []),
        { label: t(language, "wo_completed"), value: formatDate(wo.completed_at, language) },
        ...(wo.address_lines.length ? [{ label: t(language, "wo_address"), value: wo.address_lines.join(", ") }] : []),
      ]);
      doc.x = left;
      doc.y = Math.max(leftEnd, rightEnd) + 12;

      doc.font("Helvetica-Bold").fontSize(12).fillColor(text).text(wo.title, left, doc.y, { width: contentWidth });
      doc.moveDown(0.8);

      paragraph(t(language, "wo_instructions"), wo.instructions);
      paragraph(t(language, "wo_work_performed"), wo.work_performed);

      if (wo.checklist.length) {
        heading(t(language, "wo_checklist"));
        drawTable(
          doc,
          [
            { header: t(language, "description"), key: "text", width: 415 },
            { header: "", key: "done", width: 80, align: "center" },
          ],
          wo.checklist.map((c) => ({ text: c.text, done: c.is_done ? t(language, "wo_done") : t(language, "wo_not_done") })),
        );
        doc.moveDown(0.8);
      }

      if (wo.materials.length) {
        heading(t(language, "wo_materials"));
        drawTable(
          doc,
          [
            { header: t(language, "description"), key: "description", width: 275 },
            { header: t(language, "wo_expected"), key: "planned", width: 110, align: "right" },
            { header: t(language, "wo_used"), key: "used", width: 110, align: "right" },
          ],
          wo.materials.map((m) => {
            const unit = t(language, `unit_${m.unit}` as TTranslationKey);
            return {
              description: m.description,
              planned: m.quantity_planned > 0 ? `${formatQuantity(m.quantity_planned, language)} ${unit}` : "-",
              used: m.quantity_used === null ? "-" : `${formatQuantity(m.quantity_used, language)} ${unit}`,
            };
          }),
        );
        doc.moveDown(0.8);
      }

      if (wo.hours.length) {
        heading(t(language, "wo_hours"));
        drawTable(
          doc,
          [
            { header: t(language, "wo_employee"), key: "employee", width: 185 },
            { header: t(language, "date"), key: "date", width: 100 },
            { header: t(language, "wo_type"), key: "type", width: 110 },
            { header: t(language, "wo_duration"), key: "duration", width: 100, align: "right" },
          ],
          wo.hours.map((h) => ({
            employee: h.employee,
            date: formatDate(`${h.work_date}T12:00:00Z`, language),
            type: h.entry_type === "TRAVEL" ? t(language, "wo_type_travel") : t(language, "wo_type_work"),
            duration: formatDuration(h.minutes),
          })),
        );
        const total = wo.hours.reduce((n, h) => n + h.minutes, 0);
        doc.moveDown(0.3);
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(text).text(`${t(language, "wo_total_hours")}: ${formatDuration(total)}`, left, doc.y, {
          width: contentWidth,
          align: "right",
        });
        doc.moveDown(1);
      }

      if (wo.photo_count > 0) {
        doc.font("Helvetica").fontSize(9).fillColor(muted).text(`${t(language, "wo_photos")}: ${wo.photo_count}`, left, doc.y, { width: contentWidth });
        doc.moveDown(1);
      }

      // Customer sign-off
      ensureSpace(150);
      heading(t(language, "wo_signature"));
      if (wo.signature) {
        try {
          doc.image(wo.signature.png, left, doc.y, { fit: [220, 90] });
          doc.y += 95;
        } catch {
          // an unreadable image only means the drawing is missing; the name stays
        }
        doc.font("Helvetica").fontSize(9.5).fillColor(text).text(
          `${t(language, "wo_signed_by")}: ${wo.signature.name} (${formatDate(wo.signature.signed_at, language)})`,
          left,
          doc.y,
          { width: contentWidth },
        );
      } else {
        doc.font("Helvetica").fontSize(9.5).fillColor(muted).text(t(language, "wo_not_signed"), left, doc.y, { width: contentWidth });
      }
    },
    { title: `${t(language, "wo_title")} ${wo.number}`, language },
  );
