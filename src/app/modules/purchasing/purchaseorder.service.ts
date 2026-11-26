import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { loadLogo } from "../../lib/pdfService";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { amsterdamToday, isValidDay } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { formatDate, formatMoney } from "../../utils/formatters";
import { TLanguage, toLanguage } from "../../utils/i18n";
import { fromCents, toCents } from "../../utils/money";
import { calculateTotals, totalsToAmounts } from "../quote/quote.calculation";
import { SettingsService } from "../settings/settings.service";
import {
  ICreatePurchaseOrder,
  IOrderPurchaseOrder,
  IPurchaseOrderHeader,
  IReceiveGoods,
  purchaseOrderStatuses,
  IPurchaseLineInput,
} from "./purchasing.interface";
import { buildPurchaseOrderPdf } from "./purchaseorder.pdf";
import {
  clean,
  insertLines,
  loadSupplier,
  lockPurchaseOrder,
  logPurchasingEvent,
  normalizeAddress,
  prepareLines,
  recomputeTotals,
  round2,
  run,
  todaySql,
} from "./purchasing.shared";

// Inkoop, part 1 (SRS 4.12): purchase orders to suppliers. A draft is made for a supplier
// (optionally for a project) with lines and an expected delivery date. Ordering gives it its
// number and PDF; it is emailed to the supplier (suppliers do not log in). Goods are booked
// as received, and the supplier's invoices are matched against the order.

const asList = (value: any): string[] =>
  String(Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const assertDay = (value: any, label: string) => {
  const day = String(value);
  if (!isValidDay(day)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${label} must be a date like 2026-11-30!`);
  }
  return day;
};

const loadProject = async (client: any, projectId: string) => {
  assertUuid(projectId, "project id");
  const result = await client.query(
    `SELECT id, number, title, closed_at, street, house_number, postcode, city, country FROM projects WHERE id = $1::uuid`,
    [projectId],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  }
  if (result.rows[0].closed_at) {
    throw new ApiError(httpStatus.CONFLICT, "This project is closed. Reopen it before ordering for it!");
  }
  return result.rows[0];
};

const assertNotPast = (day: string | null | undefined) => {
  if (day && day < amsterdamToday()) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The expected delivery date cannot be in the past!");
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const isLateSql = `(po.status IN ('ORDERED', 'PARTIALLY_RECEIVED') AND po.expected_delivery_date < ${todaySql})`;

export const readPurchaseOrder = async (id: string, client?: any) => {
  assertUuid(id, "purchase order id");
  const q = run(client);

  const result = await q(
    `
      SELECT po.id, po.number, po.status, po.title, po.supplier_reference, po.language::text AS language,
             to_char(po.order_date, 'YYYY-MM-DD') AS order_date,
             to_char(po.expected_delivery_date, 'YYYY-MM-DD') AS expected_delivery_date,
             po.delivery_street, po.delivery_house_number, po.delivery_postcode, po.delivery_city, po.delivery_country,
             po.recipient_name, po.recipient_email, po.notes, po.internal_notes,
             po.total_excl_vat::float8 AS total_excl_vat, po.total_vat::float8 AS total_vat, po.total_incl_vat::float8 AS total_incl_vat,
             po.ordered_at, ou.name AS ordered_by_name, po.sent_at, po.sent_to, po.received_at,
             po.cancelled_at, po.cancel_reason, (po.pdf_data IS NOT NULL) AS has_pdf,
             po.created_by, po.created_at AS "createdAt", po.updated_at AS "updatedAt",
             ${isLateSql} AS is_late,
             json_build_object('id', s.id, 'name', s.name, 'email', s.email) AS supplier,
             CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'number', p.number, 'title', p.title) END AS project
      FROM purchase_orders po
      JOIN relations s ON s.id = po.supplier_id
      LEFT JOIN projects p ON p.id = po.project_id
      LEFT JOIN users ou ON ou.id = po.ordered_by
      WHERE po.id = $1::uuid
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Purchase order not found!");
  }
  const po = result.rows[0];

  const [lines, invoices] = await Promise.all([
    q(
      `
        SELECT id, sort_order, catalogue_item_id, description, quantity::float8 AS quantity, unit,
               unit_price::float8 AS unit_price, vat_code, vat_rate::float8 AS vat_rate, vat_reverse_charge,
               line_total::float8 AS line_total, quantity_received::float8 AS quantity_received
        FROM purchase_order_lines WHERE purchase_order_id = $1::uuid ORDER BY sort_order ASC
      `,
      [id],
    ),
    q(
      `
        SELECT id, invoice_number, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, status,
               amount_excl_vat::float8 AS amount_excl_vat, amount_incl_vat::float8 AS amount_incl_vat
        FROM supplier_invoices WHERE purchase_order_id = $1::uuid ORDER BY created_at ASC
      `,
      [id],
    ),
  ]);

  const detailedLines = lines.rows.map((l: any) => ({
    ...l,
    quantity_outstanding: Math.round((l.quantity - l.quantity_received) * 1000) / 1000,
  }));
  const calculation = totalsToAmounts(
    calculateTotals(lines.rows.map((l: any) => ({ ...l, cost_price: 0 }))),
  );

  const live = invoices.rows.filter((i: any) => i.status !== "VOID");
  const invoicedExclCents = live.reduce((n: number, i: any) => n + toCents(i.amount_excl_vat), 0);
  const totalLineCents = lines.rows.reduce((n: number, l: any) => n + toCents(l.line_total), 0);
  const receivedCents = lines.rows.reduce((n: number, l: any) => n + Math.round(toCents(l.line_total) * (l.quantity_received / l.quantity)), 0);

  return {
    ...po,
    delivery_address: po.delivery_street
      ? { street: po.delivery_street, house_number: po.delivery_house_number, postcode: po.delivery_postcode, city: po.delivery_city, country: po.delivery_country }
      : null,
    lines: detailedLines,
    calculation,
    supplier_invoices: invoices.rows,
    invoiced: {
      excl_vat: fromCents(invoicedExclCents),
      // more invoiced than ordered (a warning, not a block)
      over_ordered: invoicedExclCents > toCents(po.total_excl_vat),
      remaining_excl_vat: fromCents(Math.max(0, toCents(po.total_excl_vat) - invoicedExclCents)),
    },
    received_percentage: totalLineCents > 0 ? Math.round((receivedCents / totalLineCents) * 100) : 0,
    can_edit: po.status === "DRAFT",
    can_order: po.status === "DRAFT" && lines.rows.length > 0,
    can_send: ["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status),
    can_receive: ["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status),
    can_cancel: po.status === "ORDERED" && live.length === 0,
  };
};

const getPurchaseOrderById = (id: string) => readPurchaseOrder(id);

const getAllPurchaseOrders = async (params: Record<string, any>) => {
  const { page, limit, skip, sortBy, sortOrder } = paginationHelper.calculatePagination(params as any);

  const sortable: Record<string, string> = {
    created_at: "po.created_at",
    number: "po.number",
    order_date: "po.order_date",
    expected_delivery_date: "po.expected_delivery_date",
    total: "po.total_incl_vat",
    supplier: "LOWER(s.name)",
  };
  const orderColumn = sortable[sortBy] ?? "po.created_at";
  const orderDirection = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  const conditions: string[] = [];
  const values: any[] = [];
  let n = 1;

  if (params.searchTerm) {
    const term = String(Array.isArray(params.searchTerm) ? params.searchTerm[0] : params.searchTerm)
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(
      `(po.number ILIKE $${n} OR po.title ILIKE $${n} OR po.supplier_reference ILIKE $${n} OR s.name ILIKE $${n} OR p.number ILIKE $${n})`,
    );
    values.push(`%${term}%`);
    n++;
  }
  if (params.status) {
    const statuses = asList(params.status).map((s) => s.toUpperCase());
    if (statuses.some((s) => !(purchaseOrderStatuses as readonly string[]).includes(s))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Status should be DRAFT, ORDERED, PARTIALLY_RECEIVED, RECEIVED or CANCELLED!");
    }
    conditions.push(`po.status = ANY($${n++}::"PurchaseOrderStatus"[])`);
    values.push(statuses);
  }
  for (const [param, column, label] of [
    ["supplier_id", "po.supplier_id", "supplier id"],
    ["project_id", "po.project_id", "project id"],
  ] as const) {
    if (params[param]) {
      assertUuid(String(params[param]), label);
      conditions.push(`${column} = $${n++}::uuid`);
      values.push(String(params[param]));
    }
  }
  // Ordered but not delivered by the expected date
  if (String(params.late) === "true") conditions.push(isLateSql);
  for (const [param, column, operator] of [
    ["expected_from", "po.expected_delivery_date", ">="],
    ["expected_to", "po.expected_delivery_date", "<="],
    ["ordered_from", "po.order_date", ">="],
    ["ordered_to", "po.order_date", "<="],
  ] as const) {
    if (params[param]) {
      conditions.push(`${column} ${operator} $${n++}::date`);
      values.push(assertDay(params[param], param));
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `
    FROM purchase_orders po
    JOIN relations s ON s.id = po.supplier_id
    LEFT JOIN projects p ON p.id = po.project_id
    ${where}
  `;

  const [result, totals] = await Promise.all([
    query(
      `
        SELECT po.id, po.number, po.status, po.title, po.supplier_reference,
               to_char(po.order_date, 'YYYY-MM-DD') AS order_date,
               to_char(po.expected_delivery_date, 'YYYY-MM-DD') AS expected_delivery_date,
               po.total_excl_vat::float8 AS total_excl_vat, po.total_incl_vat::float8 AS total_incl_vat,
               ${isLateSql} AS is_late, po.sent_at, po.created_at AS "createdAt",
               json_build_object('id', s.id, 'name', s.name) AS supplier,
               CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'number', p.number) END AS project
        ${from}
        ORDER BY ${orderColumn} ${orderDirection} NULLS LAST, po.id ASC
        LIMIT $${n} OFFSET $${n + 1}
      `,
      [...values, limit, skip],
    ),
    query(
      `
        SELECT COUNT(*)::int AS total,
               COALESCE(SUM(po.total_excl_vat) FILTER (WHERE po.status <> 'CANCELLED'), 0)::float8 AS ordered,
               COALESCE(SUM(po.total_excl_vat) FILTER (WHERE po.status IN ('ORDERED', 'PARTIALLY_RECEIVED')), 0)::float8 AS open
        ${from}
      `,
      values,
    ),
  ]);

  const total = totals.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    totals: { orders: total, total_excl_vat: round2(totals.rows[0].ordered), open_excl_vat: round2(totals.rows[0].open) },
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

// ---------------------------------------------------------------------------
// Creating and editing a draft (FR-PUR-01)
// ---------------------------------------------------------------------------

const createPurchaseOrder = async (input: ICreatePurchaseOrder, actorId: string) => {
  assertNotPast(input.expected_delivery_date);
  const prepared = input.lines ? await prepareLines(input.lines) : [];

  const id = await transaction(async (client) => {
    const supplier = await loadSupplier(client, input.supplier_id);
    const project = input.project_id ? await loadProject(client, input.project_id) : null;

    // The delivery address: the one given, else the project's
    const address =
      input.delivery_address !== undefined
        ? input.delivery_address
          ? normalizeAddress(input.delivery_address)
          : null
        : project?.street
          ? normalizeAddress(project)
          : null;

    const created = await client.query(
      `
        INSERT INTO purchase_orders (
          supplier_id, project_id, title, supplier_reference, language, expected_delivery_date,
          delivery_street, delivery_house_number, delivery_postcode, delivery_city, delivery_country,
          recipient_name, recipient_email, notes, internal_notes, created_by
        ) VALUES (
          $1::uuid, $2::uuid, $3, $4, $5::"Language", $6::date,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16::uuid
        ) RETURNING id
      `,
      [
        supplier.id,
        project?.id ?? null,
        clean(input.title) ?? (project ? `Order for ${project.title}` : null),
        clean(input.supplier_reference),
        input.language ?? toLanguage(supplier.preferred_language),
        input.expected_delivery_date ?? null,
        address?.street ?? null,
        address?.house_number ?? null,
        address?.postcode ?? null,
        address?.city ?? null,
        address?.country ?? null,
        clean(input.recipient_name) ?? supplier.contact_name ?? supplier.name,
        clean(input.recipient_email)?.toLowerCase() ?? supplier.contact_email ?? supplier.email ?? null,
        clean(input.notes),
        clean(input.internal_notes),
        actorId,
      ],
    );
    const poId = created.rows[0].id as string;
    await insertLines(client, poId, prepared);
    await recomputeTotals(client, poId);
    await logAudit(
      { actor_id: actorId, action: "CREATE", entity_type: "purchase_order", entity_id: poId, changes: { supplier_id: supplier.id, project_id: project?.id ?? null } },
      client,
    );
    return poId;
  });

  return readPurchaseOrder(id);
};

// A draft can change freely. Once ordered, only the delivery date and the office's own note:
// what the supplier received must not change behind their back.
const updatePurchaseOrder = async (id: string, payload: IPurchaseOrderHeader, actorId: string) => {
  if (payload.expected_delivery_date !== undefined) assertNotPast(payload.expected_delivery_date);

  await transaction(async (client) => {
    const po = await lockPurchaseOrder(client, id);
    if (po.status === "CANCELLED") {
      throw new ApiError(httpStatus.CONFLICT, "A cancelled purchase order cannot be changed!");
    }

    const allowed = po.status === "DRAFT" ? null : po.status === "RECEIVED" ? ["internal_notes"] : ["expected_delivery_date", "internal_notes"];
    if (allowed && Object.keys(payload).some((k) => !allowed.includes(k))) {
      throw new ApiError(
        httpStatus.CONFLICT,
        `This purchase order has been ordered. Only ${allowed.map((a) => a.replace(/_/g, " ")).join(" and ")} can still be changed!`,
      );
    }

    const data: Record<string, any> = {};
    if (payload.title !== undefined) data.title = clean(payload.title);
    if (payload.supplier_reference !== undefined) data.supplier_reference = clean(payload.supplier_reference);
    if (payload.language !== undefined) data.language = payload.language;
    if (payload.expected_delivery_date !== undefined) data.expected_delivery_date = payload.expected_delivery_date;
    if (payload.recipient_name !== undefined) data.recipient_name = clean(payload.recipient_name);
    if (payload.recipient_email !== undefined) data.recipient_email = clean(payload.recipient_email)?.toLowerCase() ?? null;
    if (payload.notes !== undefined) data.notes = clean(payload.notes);
    if (payload.internal_notes !== undefined) data.internal_notes = clean(payload.internal_notes);
    if (payload.project_id !== undefined) {
      data.project_id = payload.project_id ? (await loadProject(client, payload.project_id)).id : null;
    }
    if (payload.delivery_address !== undefined) {
      const a = payload.delivery_address ? normalizeAddress(payload.delivery_address) : null;
      data.delivery_street = a?.street ?? null;
      data.delivery_house_number = a?.house_number ?? null;
      data.delivery_postcode = a?.postcode ?? null;
      data.delivery_city = a?.city ?? null;
      data.delivery_country = a?.country ?? null;
    }

    const casts: Record<string, string> = { language: '::"Language"', expected_delivery_date: "::date", project_id: "::uuid" };
    const updates: string[] = [];
    const values: any[] = [];
    let n = 1;
    for (const [field, value] of Object.entries(data)) {
      updates.push(`${field} = $${n++}${casts[field] ?? ""}`);
      values.push(value);
    }
    if (updates.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
    }
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    await client.query(`UPDATE purchase_orders SET ${updates.join(", ")} WHERE id = $${n}::uuid`, values);

    if (po.status !== "DRAFT" && payload.expected_delivery_date !== undefined) {
      await logPurchasingEvent(
        client,
        po.supplier_id,
        { type: "purchase_order", id },
        "PURCHASE_ORDER_DELIVERY_DATE_CHANGED",
        `Delivery date of ${po.number} changed to ${payload.expected_delivery_date ?? "none"}`,
        actorId,
      );
    }
    await logAudit({ actor_id: actorId, action: "UPDATE", entity_type: "purchase_order", entity_id: id, changes: { fields: Object.keys(data) } }, client);
  });

  return readPurchaseOrder(id);
};

const setLines = async (id: string, lines: IPurchaseLineInput[], actorId: string) => {
  const prepared = await prepareLines(lines);

  await transaction(async (client) => {
    const po = await lockPurchaseOrder(client, id);
    if (po.status !== "DRAFT") {
      throw new ApiError(httpStatus.CONFLICT, "Only a draft purchase order can be changed. Cancel it and make a new one!");
    }
    await client.query(`DELETE FROM purchase_order_lines WHERE purchase_order_id = $1::uuid`, [id]);
    await insertLines(client, id, prepared);
    await recomputeTotals(client, id);
    await logAudit({ actor_id: actorId, action: "UPDATE", entity_type: "purchase_order", entity_id: id, changes: { lines: prepared.length } }, client);
  });

  return readPurchaseOrder(id);
};

const deletePurchaseOrder = async (id: string, actorId: string) => {
  await transaction(async (client) => {
    const po = await lockPurchaseOrder(client, id);
    if (po.status !== "DRAFT") {
      throw new ApiError(httpStatus.CONFLICT, "Only a draft can be deleted. An ordered purchase order is cancelled instead!");
    }
    await client.query(`DELETE FROM purchase_orders WHERE id = $1::uuid`, [id]);
    await logAudit({ actor_id: actorId, action: "DELETE", entity_type: "purchase_order", entity_id: id, changes: { draft: true } }, client);
  });
};

// ---------------------------------------------------------------------------
// Ordering and sending (FR-PUR-02)
// ---------------------------------------------------------------------------

const pdfInput = (po: any, number: string, orderDate: string) => ({
  number,
  order_date: orderDate,
  title: po.title,
  supplier_reference: po.supplier_reference,
  expected_delivery_date: po.expected_delivery_date,
  supplier: { name: po.supplier.name, contact_name: po.recipient_name && po.recipient_name !== po.supplier.name ? po.recipient_name : null },
  project: po.project,
  delivery_lines: po.delivery_address
    ? [
        [po.delivery_address.street, po.delivery_address.house_number].filter(Boolean).join(" "),
        [po.delivery_address.postcode, po.delivery_address.city].filter(Boolean).join(" "),
      ].filter(Boolean)
    : [],
  notes: po.notes,
  lines: po.lines,
  vat: po.calculation.vat,
  total_excl_vat: po.calculation.total_excl_vat,
  total_incl_vat: po.calculation.total_incl_vat,
});

// Draft -> Ordered: the number, the order date and the PDF are made in one transaction
const orderPurchaseOrder = async (id: string, input: IOrderPurchaseOrder, actorId: string) => {
  const company = await SettingsService.getCompanySettings();
  const logo = await loadLogo(company.logo_url);

  await transaction(async (client) => {
    const po = await lockPurchaseOrder(client, id);
    if (po.status !== "DRAFT") {
      throw new ApiError(httpStatus.CONFLICT, "This purchase order has already been ordered!");
    }
    const totals = await recomputeTotals(client, id);
    if (totals.totalCents <= 0) {
      throw new ApiError(httpStatus.CONFLICT, "A purchase order needs lines with a total above zero!");
    }
    await loadSupplier(client, po.supplier_id);
    if (po.project_id) await loadProject(client, po.project_id);

    const number = await SettingsService.nextDocumentNumber("purchase_order", client);
    const orderDate = amsterdamToday();
    await client.query(
      `
        UPDATE purchase_orders
        SET number = $2, status = 'ORDERED', order_date = $3::date, ordered_at = CURRENT_TIMESTAMP,
            ordered_by = $4::uuid, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [id, number, orderDate, actorId],
    );

    const view = await readPurchaseOrder(id, client);
    const language = toLanguage(view.language);
    const pdf = await buildPurchaseOrderPdf(pdfInput(view, number, orderDate), company, language, { logo });
    await client.query(`UPDATE purchase_orders SET pdf_data = $2 WHERE id = $1::uuid`, [id, pdf]);

    await logPurchasingEvent(
      client,
      po.supplier_id,
      { type: "purchase_order", id },
      "PURCHASE_ORDER_ORDERED",
      `Purchase order ${number} placed (${formatMoney(view.total_incl_vat, "EN")})`,
      actorId,
      { metadata: { project_id: po.project_id } },
    );
    await logAudit(
      { actor_id: actorId, action: "STATUS_CHANGE", entity_type: "purchase_order", entity_id: id, changes: { to: "ORDERED", number, total_excl_vat: view.total_excl_vat } },
      client,
    );
  });

  if (input.send) {
    // Ordered is ordered: failing to send does not undo it
    let delivery: { sent: boolean; to?: string; error?: string };
    try {
      const sent = await sendPurchaseOrder(id, input.email, actorId);
      delivery = { sent: true, to: sent.sent_to as string };
    } catch (error: any) {
      delivery = { sent: false, error: error?.message ?? "Sending failed" };
    }
    return { ...(await readPurchaseOrder(id)), delivery };
  }
  return readPurchaseOrder(id);
};

// Emails the PDF to the supplier. Marked as sent only once the email has really gone out.
const sendPurchaseOrder = async (id: string, emailOverride: string | undefined, actorId: string) => {
  assertUuid(id, "purchase order id");
  const found = await query(
    `
      SELECT po.id, po.number, po.status, po.supplier_id, po.language::text AS language, po.recipient_name, po.recipient_email,
             po.pdf_data, to_char(po.expected_delivery_date, 'YYYY-MM-DD') AS expected, po.total_incl_vat::float8 AS total,
             s.name AS supplier_name, s.email AS supplier_email, p.number AS project_number, p.title AS project_title
      FROM purchase_orders po
      JOIN relations s ON s.id = po.supplier_id
      LEFT JOIN projects p ON p.id = po.project_id
      WHERE po.id = $1::uuid
    `,
    [id],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Purchase order not found!");
  }
  const po = found.rows[0];
  if (!["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status) || !po.pdf_data) {
    throw new ApiError(httpStatus.CONFLICT, "Only an ordered purchase order can be sent. Order it first!");
  }
  const to = clean(emailOverride)?.toLowerCase() ?? po.recipient_email ?? po.supplier_email;
  if (!to) {
    throw new ApiError(httpStatus.BAD_REQUEST, "There is no email address to send this to!");
  }
  const language: TLanguage = toLanguage(po.language);

  await sendTemplatedEmail({
    to,
    templateKey: "purchase_order",
    language,
    variables: {
      name: po.recipient_name ?? po.supplier_name,
      purchase_order_number: po.number,
      project: po.project_number ? `${po.project_number} ${po.project_title}` : "-",
      expected_delivery: po.expected ? formatDate(`${po.expected}T12:00:00Z`, language) : "-",
      total: formatMoney(po.total, language),
    },
    attachments: [{ filename: `${po.number}.pdf`, content: po.pdf_data, contentType: "application/pdf" }],
    related: { type: "purchase_order", id },
    sentBy: actorId,
  });

  await transaction(async (client) => {
    await client.query(`UPDATE purchase_orders SET sent_at = CURRENT_TIMESTAMP, sent_to = $2 WHERE id = $1::uuid`, [id, to]);
    await logPurchasingEvent(client, po.supplier_id, { type: "purchase_order", id }, "PURCHASE_ORDER_SENT", `Purchase order ${po.number} sent to ${to}`, actorId);
  });

  return { sent_to: to };
};

const getPdf = async (id: string) => {
  assertUuid(id, "purchase order id");
  const found = await query(`SELECT id, number, status, pdf_data FROM purchase_orders WHERE id = $1::uuid`, [id]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Purchase order not found!");
  }
  const row = found.rows[0];
  if (row.pdf_data) return { pdf: row.pdf_data as Buffer, filename: `${row.number}.pdf` };

  // A draft gets a preview (not stored)
  const company = await SettingsService.getCompanySettings();
  const logo = await loadLogo(company.logo_url);
  const view = await readPurchaseOrder(id);
  const pdf = await buildPurchaseOrderPdf(pdfInput(view, "DRAFT", amsterdamToday()), company, toLanguage(view.language), { logo });
  return { pdf, filename: "purchase-order-draft.pdf" };
};

// ---------------------------------------------------------------------------
// Receiving goods and cancelling
// ---------------------------------------------------------------------------

// Books what has arrived. When every line is complete the order is RECEIVED.
const receiveGoods = async (id: string, input: IReceiveGoods, actorId: string) => {
  await transaction(async (client) => {
    const po = await lockPurchaseOrder(client, id);
    if (!["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status)) {
      throw new ApiError(httpStatus.CONFLICT, "Goods can only be received on an ordered purchase order!");
    }

    const lines = await client.query(
      `SELECT id, description, quantity::float8 AS quantity, quantity_received::float8 AS received
       FROM purchase_order_lines WHERE purchase_order_id = $1::uuid ORDER BY sort_order ASC FOR UPDATE`,
      [id],
    );
    const byId = new Map<string, any>(lines.rows.map((l: any) => [l.id, l]));

    let picks: { line: any; quantity: number }[];
    if (input.all) {
      picks = lines.rows
        .filter((l: any) => l.quantity - l.received > 0.0004)
        .map((l: any) => ({ line: l, quantity: Math.round((l.quantity - l.received) * 1000) / 1000 }));
      if (picks.length === 0) {
        throw new ApiError(httpStatus.CONFLICT, "Everything has already been received!");
      }
    } else {
      const seen = new Set<string>();
      picks = (input.lines ?? []).map((p) => {
        const line = byId.get(p.line_id);
        if (!line) throw new ApiError(httpStatus.BAD_REQUEST, "A line does not belong to this purchase order!");
        if (seen.has(line.id)) throw new ApiError(httpStatus.BAD_REQUEST, "A line appears twice!");
        seen.add(line.id);
        const left = Math.round((line.quantity - line.received) * 1000) / 1000;
        if (p.quantity > left + 1e-9) {
          throw new ApiError(httpStatus.CONFLICT, `Only ${left} of "${line.description}" is still outstanding!`);
        }
        return { line, quantity: p.quantity };
      });
    }

    for (const pick of picks) {
      await client.query(`UPDATE purchase_order_lines SET quantity_received = quantity_received + $2 WHERE id = $1::uuid`, [pick.line.id, pick.quantity]);
    }

    const open = await client.query(
      `SELECT COUNT(*)::int AS n FROM purchase_order_lines WHERE purchase_order_id = $1::uuid AND quantity - quantity_received > 0.0004`,
      [id],
    );
    const done = open.rows[0].n === 0;
    await client.query(
      `UPDATE purchase_orders SET status = $2, received_at = CASE WHEN $3::boolean THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, done ? "RECEIVED" : "PARTIALLY_RECEIVED", done],
    );

    await logPurchasingEvent(
      client,
      po.supplier_id,
      { type: "purchase_order", id },
      done ? "PURCHASE_ORDER_RECEIVED" : "PURCHASE_ORDER_PARTIALLY_RECEIVED",
      `Goods received on ${po.number}${done ? " (complete)" : ""}`,
      actorId,
      { metadata: { lines: picks.length } },
    );
    await logAudit({ actor_id: actorId, action: "UPDATE", entity_type: "purchase_order", entity_id: id, changes: { received_lines: picks.length, complete: done } }, client);
  });

  return readPurchaseOrder(id);
};

// Only an order nothing has been delivered or invoiced against
const cancelPurchaseOrder = async (id: string, reason: string, actorId: string) => {
  await transaction(async (client) => {
    const po = await lockPurchaseOrder(client, id);
    if (po.status === "DRAFT") {
      throw new ApiError(httpStatus.CONFLICT, "A draft is deleted, not cancelled!");
    }
    if (po.status !== "ORDERED") {
      throw new ApiError(
        httpStatus.CONFLICT,
        po.status === "CANCELLED" ? "This purchase order is already cancelled!" : "Goods have been received on this purchase order, so it cannot be cancelled!",
      );
    }
    const invoices = await client.query(
      `SELECT COUNT(*)::int AS n FROM supplier_invoices WHERE purchase_order_id = $1::uuid AND status <> 'VOID'`,
      [id],
    );
    if (invoices.rows[0].n > 0) {
      throw new ApiError(httpStatus.CONFLICT, "A supplier invoice is linked to this purchase order, so it cannot be cancelled!");
    }

    await client.query(
      `UPDATE purchase_orders SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, reason.trim()],
    );
    await logPurchasingEvent(client, po.supplier_id, { type: "purchase_order", id }, "PURCHASE_ORDER_CANCELLED", `Purchase order ${po.number} cancelled`, actorId, {
      description: reason.trim(),
    });
    await logAudit({ actor_id: actorId, action: "STATUS_CHANGE", entity_type: "purchase_order", entity_id: id, changes: { to: "CANCELLED", reason: reason.trim() } }, client);
  });

  return readPurchaseOrder(id);
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const getHistory = async (id: string, params: Record<string, any>) => {
  assertUuid(id, "purchase order id");
  const exists = await query(`SELECT 1 FROM purchase_orders WHERE id = $1::uuid`, [id]);
  if (exists.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Purchase order not found!");
  }

  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const scope = `t.entity_type = 'purchase_order' AND t.entity_id = $1::uuid`;
  const [result, count] = await Promise.all([
    query(
      `
        SELECT t.id, t.event_type, t.entity_id, t.title, t.description, t.metadata, t.actor_id,
               u.name AS actor_name, t.created_at AS "createdAt"
        FROM relation_timeline t LEFT JOIN users u ON u.id = t.actor_id
        WHERE ${scope} ORDER BY t.created_at DESC, t.id DESC LIMIT $2 OFFSET $3
      `,
      [id, limit, skip],
    ),
    query(`SELECT COUNT(*) AS total FROM relation_timeline t WHERE ${scope}`, [id]),
  ]);
  const total = parseInt(count.rows[0].total);
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

export const PurchaseOrderService = {
  createPurchaseOrder,
  getAllPurchaseOrders,
  getPurchaseOrderById,
  updatePurchaseOrder,
  setLines,
  deletePurchaseOrder,
  orderPurchaseOrder,
  sendPurchaseOrder,
  getPdf,
  receiveGoods,
  cancelPurchaseOrder,
  getHistory,
};
