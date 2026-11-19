import PDFDocument from "pdfkit";
import { formatDate, formatMoney } from "../utils/formatters";
import { t, TLanguage } from "../utils/i18n";

// Shared building blocks for every PDF the CRM produces: quotations, invoices,
// work orders and purchase orders (NFR-PERF-03: under 5 seconds). Each document
// module supplies its own content; this file supplies the letterhead, tables and
// the page footer so they all look the same.

type TPdfDoc = InstanceType<typeof PDFDocument>;

export interface ICompanyDetails {
  company_name: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  street?: string | null;
  house_number?: string | null;
  postcode?: string | null;
  city?: string | null;
  kvk_number?: string | null;
  vat_number?: string | null;
  iban?: string | null;
}

export interface ITableColumn {
  header: string;
  key: string;
  width: number;
  align?: "left" | "right" | "center";
}

const MARGIN = 50;
const COLOR_TEXT = "#1f2933";
const COLOR_MUTED = "#6b7280";
const COLOR_LINE = "#d1d5db";

// Shared with the document modules (quotations, invoices) so they match the letterhead
export const PDF_MARGIN = MARGIN;
export const PDF_COLORS = { text: COLOR_TEXT, muted: COLOR_MUTED, line: COLOR_LINE };

// Runs `draw` against a new A4 document and resolves with the finished PDF bytes.
// Footers with "Page x of y" are added to every page afterwards.
export const buildPdf = (
  draw: (doc: TPdfDoc) => void | Promise<void>,
  options: { title?: string; language?: TLanguage; footerText?: string } = {},
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const language = options.language ?? "NL";
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGIN,
      bufferPages: true,
      info: { Title: options.title ?? "Document", Producer: "Betonherstel CRM" },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    Promise.resolve(draw(doc))
      .then(() => {
        const range = doc.bufferedPageRange();
        for (let i = 0; i < range.count; i++) {
          doc.switchToPage(range.start + i);
          drawFooter(doc, `${t(language, "page")} ${i + 1} ${t(language, "of")} ${range.count}`, options.footerText);
        }
        doc.end();
      })
      .catch(reject);
  });

// Footer sits inside the bottom margin; the margin is zeroed while writing it so
// pdfkit does not start a new page for it.
const drawFooter = (doc: TPdfDoc, pageText: string, footerText?: string) => {
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const y = doc.page.height - 36;
  doc.fontSize(8).fillColor(COLOR_MUTED);
  if (footerText) {
    doc.text(footerText, MARGIN, y, { width: doc.page.width - MARGIN * 2 - 80, lineBreak: false });
  }
  doc.text(pageText, doc.page.width - MARGIN - 80, y, { width: 80, align: "right", lineBreak: false });
  doc.page.margins.bottom = bottom;
};

// One line with the details a Dutch business document must carry
export const companyFooterLine = (company: ICompanyDetails, language: TLanguage) =>
  [
    company.company_name,
    company.kvk_number && `${t(language, "company_kvk")} ${company.kvk_number}`,
    company.vat_number && `${t(language, "company_vat")} ${company.vat_number}`,
    company.iban && `${t(language, "company_iban")} ${company.iban}`,
  ]
    .filter(Boolean)
    .join("  |  ");

// Logo (or company name) on the left, company details on the right. Leaves the
// cursor below the header.
export const drawLetterhead = (
  doc: TPdfDoc,
  company: ICompanyDetails,
  language: TLanguage,
  logo?: Buffer | null,
) => {
  const top = MARGIN;
  const right = doc.page.width - MARGIN;

  let drewLogo = false;
  if (logo) {
    try {
      doc.image(logo, MARGIN, top, { fit: [150, 55] });
      drewLogo = true;
    } catch {
      // unreadable image: fall back to the company name
    }
  }
  if (!drewLogo) {
    doc.font("Helvetica-Bold").fontSize(18).fillColor(COLOR_TEXT).text(company.company_name, MARGIN, top, { width: 250 });
  }

  const addressLine = [
    [company.street, company.house_number].filter(Boolean).join(" "),
    [company.postcode, company.city].filter(Boolean).join(" "),
  ].filter(Boolean);
  const detailLines = [
    ...addressLine,
    company.phone && `${t(language, "company_phone")} ${company.phone}`,
    company.email && `${t(language, "company_email")} ${company.email}`,
    company.website,
  ].filter(Boolean) as string[];

  doc.font("Helvetica").fontSize(9).fillColor(COLOR_MUTED);
  let y = top;
  for (const line of detailLines) {
    doc.text(line, right - 220, y, { width: 220, align: "right", lineBreak: false });
    y += 12;
  }

  const bottom = Math.max(top + 60, y) + 12;
  doc.moveTo(MARGIN, bottom).lineTo(right, bottom).strokeColor(COLOR_LINE).lineWidth(1).stroke();
  doc.x = MARGIN;
  doc.y = bottom + 20;
  doc.fillColor(COLOR_TEXT).font("Helvetica");
};

// Simple table with a header row; continues on a new page (repeating the header)
// when it runs out of room.
export const drawTable = (
  doc: TPdfDoc,
  columns: ITableColumn[],
  rows: Record<string, string | number | null | undefined>[],
) => {
  const rowPadding = 5;
  const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);

  const drawRow = (cells: string[], header: boolean) => {
    doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    const heights = cells.map((text, i) =>
      doc.heightOfString(text, { width: columns[i].width - 8 }),
    );
    const rowHeight = Math.max(...heights) + rowPadding * 2;

    if (doc.y + rowHeight > doc.page.height - MARGIN - 20) {
      doc.addPage();
      drawRow(columns.map((c) => c.header), true);
    }

    const y = doc.y;
    if (header) {
      doc.rect(MARGIN, y, tableWidth, rowHeight).fill("#f3f4f6");
    }
    doc.fillColor(COLOR_TEXT).font(header ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    let x = MARGIN;
    cells.forEach((text, i) => {
      doc.text(text, x + 4, y + rowPadding, {
        width: columns[i].width - 8,
        align: columns[i].align ?? "left",
      });
      x += columns[i].width;
    });
    doc
      .moveTo(MARGIN, y + rowHeight)
      .lineTo(MARGIN + tableWidth, y + rowHeight)
      .strokeColor(COLOR_LINE)
      .lineWidth(0.5)
      .stroke();
    doc.x = MARGIN;
    doc.y = y + rowHeight;
  };

  drawRow(columns.map((c) => c.header), true);
  for (const row of rows) {
    drawRow(columns.map((c) => String(row[c.key] ?? "")), false);
  }
};

// Downloads the company logo for embedding. A failure only means "no logo".
export const loadLogo = async (url?: string | null): Promise<Buffer | null> => {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
};

// Sample document used by Settings -> "preview PDF"
export const createSamplePdf = (
  company: ICompanyDetails,
  language: TLanguage,
  logo?: Buffer | null,
) =>
  buildPdf(
    (doc) => {
      drawLetterhead(doc, company, language, logo);
      doc.font("Helvetica-Bold").fontSize(16).text(t(language, "sample_title"));
      doc.moveDown(0.5);
      doc.font("Helvetica").fontSize(10).fillColor(COLOR_MUTED).text(`${t(language, "date")}: ${formatDate(new Date(), language)}`);
      doc.moveDown();
      doc.fillColor(COLOR_TEXT).fontSize(10).text(t(language, "sample_body"), { width: 400 });
      doc.moveDown(1.5);
      drawTable(
        doc,
        [
          { header: t(language, "description"), key: "description", width: 255 },
          { header: t(language, "quantity"), key: "quantity", width: 70, align: "right" },
          { header: t(language, "unit_price"), key: "price", width: 85, align: "right" },
          { header: t(language, "total"), key: "total", width: 85, align: "right" },
        ],
        [
          { description: "Betonherstel balkon", quantity: "12 m²", price: formatMoney(85, language), total: formatMoney(1020, language) },
          { description: "Coating", quantity: "12 m²", price: formatMoney(24.5, language), total: formatMoney(294, language) },
          { description: "Voegwerk", quantity: "1", price: formatMoney(1250.5, language), total: formatMoney(1250.5, language) },
        ],
      );
    },
    { title: t(language, "sample_title"), language, footerText: companyFooterLine(company, language) },
  );
