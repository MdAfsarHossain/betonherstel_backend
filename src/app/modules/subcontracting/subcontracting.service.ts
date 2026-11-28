import { announceProject } from "../chat/chat.live";
import { ensureChannels } from "../chat/chat.shared";
import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { loadLogo } from "../../lib/pdfService";
import config from "../../../config";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { addDays, isValidDay } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { formatDate, formatMoney } from "../../utils/formatters";
import { TLanguage, toLanguage } from "../../utils/i18n";
import { fromCents, toCents } from "../../utils/money";
import normalizePostcode from "../../utils/normalizePostcode";
import { notify } from "../messages/notification.shared";
import { loadSupplier } from "../purchasing/purchasing.shared";
import { SupplierInvoiceService } from "../purchasing/supplierinvoice.service";
import { ProjectService } from "../project/project.service";
import { SettingsService } from "../settings/settings.service";
import {
  IActor,
  IAssignmentHeader,
  ICompleteAssignment,
  ICreateAssignment,
  IProgressInput,
  IRespondAssignment,
  assignmentStatuses,
} from "./subcontracting.interface";
import { buildAssignmentPdf } from "./subcontracting.pdf";
import { clean, lockAssignment, logAssignmentEvent, syncAssignmentInvoiced } from "./subcontracting.shared";

// Uitbesteden (SRS 4.13): a part of a project is given to a subcontractor with a scope, a
// planned period and an agreed price (FR-SUB-01), sent as a work instruction (FR-SUB-02),
// confirmed or declined (FR-SUB-03), followed up to completion and invoiced (FR-SUB-04) and
// visible in the planning (FR-SUB-05). Until the subcontractor portal exists, the office records
// the subcontractor's answer and progress; the portal will call the same functions.

const MAX_SCHEDULE_DAYS = 366;

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

const normalizeAddress = (a: { street: string; house_number: string; postcode: string; city: string; country?: string }) => ({
  street: a.street.trim(),
  house_number: a.house_number.trim(),
  postcode: normalizePostcode(a.postcode),
  city: a.city.trim(),
  country: (a.country ?? "NL").toUpperCase(),
});

const portalUrl = (id: string) => `${config.frontend_url}/portal/assignments/${id}`;

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
    throw new ApiError(httpStatus.CONFLICT, "This project is closed. Reopen it before subcontracting work!");
  }
  return result.rows[0];
};

// The VAT of a subcontracted job is usually reverse-charged (verlegd) inside construction
const resolveVat = async (code: string | undefined) => {
  const company = await SettingsService.getCompanySettings();
  const rates: { code: string; rate: number; reverse_charge: boolean }[] = company.vat_rates;
  const wanted = code ?? (rates.find((v) => v.reverse_charge) ?? rates.find((v) => v.code === "21") ?? rates[0]).code;
  const vat = rates.find((v) => v.code === wanted);
  if (!vat) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Unknown VAT code ${wanted}!`);
  }
  return vat;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const readAssignment = async (id: string, client?: any) => {
  assertUuid(id, "assignment id");
  const q = client ? client.query.bind(client) : query;

  const result = await q(
    `
      SELECT sa.id, sa.number, sa.status, sa.title, sa.scope_description,
             sa.agreed_price_excl_vat::float8 AS agreed_price_excl_vat, sa.vat_code, sa.vat_rate::float8 AS vat_rate, sa.vat_reverse_charge,
             to_char(sa.planned_start, 'YYYY-MM-DD') AS planned_start, to_char(sa.planned_end, 'YYYY-MM-DD') AS planned_end,
             sa.work_street, sa.work_house_number, sa.work_postcode, sa.work_city, sa.work_country,
             sa.language::text AS language, sa.recipient_name, sa.recipient_email, sa.internal_notes,
             sa.sent_at, sa.sent_to, (sa.pdf_data IS NOT NULL) AS has_pdf,
             sa.responded_at, sa.response_via, sa.response_comment,
             to_char(sa.proposed_start, 'YYYY-MM-DD') AS proposed_start, to_char(sa.proposed_end, 'YYYY-MM-DD') AS proposed_end,
             ru.name AS response_recorded_by_name, sa.progress_percent, sa.completed_at, sa.completed_note,
             sa.cancelled_at, sa.cancel_reason, sa.created_by, sa.created_at AS "createdAt", sa.updated_at AS "updatedAt",
             json_build_object('id', s.id, 'name', s.name, 'email', s.email) AS subcontractor,
             json_build_object('id', p.id, 'number', p.number, 'title', p.title) AS project
      FROM subcontract_assignments sa
      JOIN relations s ON s.id = sa.subcontractor_id
      JOIN projects p ON p.id = sa.project_id
      LEFT JOIN users ru ON ru.id = sa.response_recorded_by
      WHERE sa.id = $1::uuid
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Assignment not found!");
  }
  const a = result.rows[0];

  const [progress, invoices, files] = await Promise.all([
    q(
      `
        SELECT sp.id, sp.percent, sp.note, u.name AS reported_by_name, sp.created_at AS "createdAt"
        FROM subcontract_progress sp LEFT JOIN users u ON u.id = sp.reported_by
        WHERE sp.assignment_id = $1::uuid ORDER BY sp.created_at DESC, sp.id DESC
      `,
      [id],
    ),
    q(
      `
        SELECT id, invoice_number, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, status,
               amount_excl_vat::float8 AS amount_excl_vat, amount_incl_vat::float8 AS amount_incl_vat,
               (file_data IS NOT NULL) AS has_file
        FROM supplier_invoices WHERE subcontract_assignment_id = $1::uuid ORDER BY created_at ASC
      `,
      [id],
    ),
    q(
      `
        SELECT id, folder, file_name, mime_type, size_bytes, caption, file_url, share_with_subcontractor, created_at AS "createdAt"
        FROM project_files WHERE subcontract_assignment_id = $1::uuid ORDER BY created_at ASC
      `,
      [id],
    ),
  ]);

  const live = invoices.rows.filter((i: any) => i.status !== "VOID");
  const invoicedCents = live.reduce((n: number, i: any) => n + toCents(i.amount_excl_vat), 0);
  const agreedCents = toCents(a.agreed_price_excl_vat);

  return {
    ...a,
    work_address: a.work_street
      ? { street: a.work_street, house_number: a.work_house_number, postcode: a.work_postcode, city: a.work_city, country: a.work_country }
      : null,
    progress: progress.rows,
    supplier_invoices: invoices.rows,
    files: files.rows,
    invoiced: {
      excl_vat: fromCents(invoicedCents),
      // more invoiced than agreed (a warning, not a block)
      over_agreed_price: invoicedCents > agreedCents,
      remaining_excl_vat: fromCents(Math.max(0, agreedCents - invoicedCents)),
    },
    can_edit: ["DRAFT", "DECLINED"].includes(a.status),
    can_send: ["DRAFT", "SENT", "DECLINED"].includes(a.status),
    can_respond: a.status === "SENT",
    can_report_progress: a.status === "CONFIRMED",
    can_complete: a.status === "CONFIRMED",
    can_reopen: a.status === "COMPLETED",
    can_record_invoice: ["CONFIRMED", "COMPLETED", "INVOICED"].includes(a.status),
    can_cancel: ["SENT", "CONFIRMED", "DECLINED"].includes(a.status) && live.length === 0,
    can_delete: a.status === "DRAFT",
  };
};

const getAssignmentById = (id: string) => readAssignment(id);

const getAllAssignments = async (params: Record<string, any>) => {
  const { page, limit, skip, sortBy, sortOrder } = paginationHelper.calculatePagination(params as any);

  const sortable: Record<string, string> = {
    created_at: "sa.created_at",
    planned_start: "sa.planned_start",
    planned_end: "sa.planned_end",
    price: "sa.agreed_price_excl_vat",
    status: "sa.status",
    subcontractor: "LOWER(s.name)",
    number: "sa.number",
  };
  const orderColumn = sortable[sortBy] ?? "sa.created_at";
  const orderDirection = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  const conditions: string[] = [];
  const values: any[] = [];
  let n = 1;

  if (params.searchTerm) {
    const term = String(Array.isArray(params.searchTerm) ? params.searchTerm[0] : params.searchTerm)
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(`(sa.number ILIKE $${n} OR sa.title ILIKE $${n} OR s.name ILIKE $${n} OR p.number ILIKE $${n} OR p.title ILIKE $${n})`);
    values.push(`%${term}%`);
    n++;
  }
  if (params.status) {
    const statuses = asList(params.status).map((x) => x.toUpperCase());
    if (statuses.some((x) => !(assignmentStatuses as readonly string[]).includes(x))) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Status should be DRAFT, SENT, CONFIRMED, DECLINED, COMPLETED, INVOICED or CANCELLED!");
    }
    conditions.push(`sa.status = ANY($${n++}::"SubcontractAssignmentStatus"[])`);
    values.push(statuses);
  }
  for (const [param, column, label] of [
    ["project_id", "sa.project_id", "project id"],
    ["subcontractor_id", "sa.subcontractor_id", "subcontractor id"],
  ] as const) {
    if (params[param]) {
      assertUuid(String(params[param]), label);
      conditions.push(`${column} = $${n++}::uuid`);
      values.push(String(params[param]));
    }
  }
  for (const [param, column, operator] of [
    ["planned_from", "sa.planned_end", ">="],
    ["planned_to", "sa.planned_start", "<="],
  ] as const) {
    if (params[param]) {
      conditions.push(`${column} ${operator} $${n++}::date`);
      values.push(assertDay(params[param], param));
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `FROM subcontract_assignments sa JOIN relations s ON s.id = sa.subcontractor_id JOIN projects p ON p.id = sa.project_id ${where}`;

  const [result, count] = await Promise.all([
    query(
      `
        SELECT sa.id, sa.number, sa.status, sa.title, sa.agreed_price_excl_vat::float8 AS agreed_price_excl_vat,
               to_char(sa.planned_start, 'YYYY-MM-DD') AS planned_start, to_char(sa.planned_end, 'YYYY-MM-DD') AS planned_end,
               sa.progress_percent, sa.sent_at, sa.responded_at, sa.created_at AS "createdAt",
               json_build_object('id', s.id, 'name', s.name) AS subcontractor,
               json_build_object('id', p.id, 'number', p.number, 'title', p.title) AS project
        ${from}
        ORDER BY ${orderColumn} ${orderDirection} NULLS LAST, sa.id ASC
        LIMIT $${n} OFFSET $${n + 1}
      `,
      [...values, limit, skip],
    ),
    query(
      `
        SELECT COUNT(*)::int AS total,
               COALESCE(SUM(sa.agreed_price_excl_vat) FILTER (WHERE sa.status IN ('CONFIRMED', 'COMPLETED', 'INVOICED')), 0)::float8 AS agreed
        ${from}
      `,
      values,
    ),
  ]);

  const total = count.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: result.rows,
    totals: { assignments: total, agreed_excl_vat: Math.round(count.rows[0].agreed * 100) / 100 },
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

// What subcontractors are doing when (FR-SUB-05): assignments that overlap the period, so the
// planning calendar can show them next to the appointments. Drafts, declined and cancelled
// assignments are not on the calendar.
const getSchedule = async (params: Record<string, any>) => {
  if (!params.from || !params.to) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Give a from and a to date, like ?from=2026-11-01&to=2026-11-30!");
  }
  const from = assertDay(params.from, "from");
  const to = assertDay(params.to, "to");
  if (to < from) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The to date cannot be before the from date!");
  }
  if (addDays(from, MAX_SCHEDULE_DAYS) < to) {
    throw new ApiError(httpStatus.BAD_REQUEST, `A period can be at most ${MAX_SCHEDULE_DAYS} days!`);
  }

  const values: any[] = [from, to];
  let extra = "";
  if (params.project_id) {
    assertUuid(String(params.project_id), "project id");
    values.push(String(params.project_id));
    extra += ` AND sa.project_id = $3::uuid`;
  }

  const result = await query(
    `
      SELECT sa.id, sa.number, sa.status, sa.title, sa.progress_percent,
             to_char(sa.planned_start, 'YYYY-MM-DD') AS planned_start, to_char(sa.planned_end, 'YYYY-MM-DD') AS planned_end,
             sa.work_street, sa.work_house_number, sa.work_postcode, sa.work_city,
             json_build_object('id', s.id, 'name', s.name) AS subcontractor,
             json_build_object('id', p.id, 'number', p.number, 'title', p.title) AS project
      FROM subcontract_assignments sa
      JOIN relations s ON s.id = sa.subcontractor_id
      JOIN projects p ON p.id = sa.project_id
      WHERE sa.status IN ('SENT', 'CONFIRMED', 'COMPLETED', 'INVOICED')
        AND COALESCE(sa.planned_start, sa.planned_end) IS NOT NULL
        AND COALESCE(sa.planned_start, sa.planned_end) <= $2::date
        AND COALESCE(sa.planned_end, sa.planned_start) >= $1::date
        ${extra}
      ORDER BY COALESCE(sa.planned_start, sa.planned_end) ASC, sa.number ASC
    `,
    values,
  );
  return {
    from,
    to,
    assignments: result.rows.map((r: any) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      title: r.title,
      progress_percent: r.progress_percent,
      planned_start: r.planned_start,
      planned_end: r.planned_end,
      // an unconfirmed assignment is only an offer
      is_confirmed: r.status !== "SENT",
      address: r.work_street ? [[r.work_street, r.work_house_number].filter(Boolean).join(" "), [r.work_postcode, r.work_city].filter(Boolean).join(" ")].filter(Boolean).join(", ") : null,
      subcontractor: r.subcontractor,
      project: r.project,
    })),
  };
};

// ---------------------------------------------------------------------------
// Creating and changing (FR-SUB-01)
// ---------------------------------------------------------------------------

const createAssignment = async (input: ICreateAssignment, actorId: string) => {
  const vat = await resolveVat(input.vat_code);

  const id = await transaction(async (client) => {
    const subcontractor = await loadSupplier(client, input.subcontractor_id, true, "SUBCONTRACTOR");
    const project = await loadProject(client, input.project_id);

    // The work address: the one given, else the project's
    const address =
      input.work_address !== undefined
        ? input.work_address
          ? normalizeAddress(input.work_address)
          : null
        : project.street
          ? normalizeAddress(project)
          : null;

    const created = await client.query(
      `
        INSERT INTO subcontract_assignments (
          project_id, subcontractor_id, title, scope_description, agreed_price_excl_vat,
          vat_code, vat_rate, vat_reverse_charge, planned_start, planned_end,
          work_street, work_house_number, work_postcode, work_city, work_country,
          language, recipient_name, recipient_email, internal_notes, created_by
        ) VALUES (
          $1::uuid, $2::uuid, $3, $4, $5,
          $6, $7, $8, $9::date, $10::date,
          $11, $12, $13, $14, $15,
          $16::"Language", $17, $18, $19, $20::uuid
        ) RETURNING id
      `,
      [
        project.id,
        subcontractor.id,
        input.title.trim(),
        input.scope_description.trim(),
        input.agreed_price_excl_vat,
        vat.code,
        vat.rate,
        vat.reverse_charge,
        input.planned_start ?? null,
        input.planned_end ?? null,
        address?.street ?? null,
        address?.house_number ?? null,
        address?.postcode ?? null,
        address?.city ?? null,
        address?.country ?? null,
        input.language ?? toLanguage(subcontractor.preferred_language),
        clean(input.recipient_name) ?? subcontractor.contact_name ?? subcontractor.name,
        clean(input.recipient_email)?.toLowerCase() ?? subcontractor.contact_email ?? subcontractor.email ?? null,
        clean(input.internal_notes),
        actorId,
      ],
    );
    const assignmentId = created.rows[0].id as string;
    await logAssignmentEvent(client, subcontractor.id, assignmentId, "ASSIGNMENT_CREATED", `Assignment "${input.title.trim()}" drafted for ${project.number}`, actorId, {
      metadata: { project_id: project.id },
    });
    await logAudit(
      {
        actor_id: actorId,
        action: "CREATE",
        entity_type: "subcontract_assignment",
        entity_id: assignmentId,
        changes: { project_id: project.id, subcontractor_id: subcontractor.id, agreed_price_excl_vat: input.agreed_price_excl_vat },
      },
      client,
    );
    return assignmentId;
  });

  return readAssignment(id);
};

// A draft (or declined) assignment can change freely. Once the subcontractor has it, the scope,
// price and VAT must not change behind their back: only the planned dates and the office's note.
const updateAssignment = async (id: string, payload: IAssignmentHeader, actorId: string) => {
  const vat = payload.vat_code !== undefined ? await resolveVat(payload.vat_code) : null;

  await transaction(async (client) => {
    const a = await lockAssignment(client, id);
    if (a.status === "CANCELLED") {
      throw new ApiError(httpStatus.CONFLICT, "A cancelled assignment cannot be changed!");
    }

    const free = ["DRAFT", "DECLINED"].includes(a.status);
    const light = ["SENT", "CONFIRMED"].includes(a.status);
    const allowed: string[] = free
      ? Object.keys(payload)
      : light
        ? ["planned_start", "planned_end", "internal_notes"]
        : ["internal_notes"];
    const blocked = Object.keys(payload).filter((k) => !allowed.includes(k));
    if (blocked.length > 0) {
      throw new ApiError(
        httpStatus.CONFLICT,
        light
          ? `The subcontractor already has this assignment. Only the planned dates and the internal note can change (not: ${blocked.join(", ")})!`
          : `A ${a.status === "COMPLETED" || a.status === "INVOICED" ? "completed" : "closed"} assignment only allows changes to the internal note!`,
      );
    }

    const start = payload.planned_start !== undefined ? payload.planned_start : a.planned_start;
    const end = payload.planned_end !== undefined ? payload.planned_end : a.planned_end;
    if (start && end && end < start) {
      throw new ApiError(httpStatus.BAD_REQUEST, "The end date cannot be before the start date!");
    }

    const updates: string[] = [];
    const values: any[] = [id];
    let n = 2;
    const set = (column: string, value: any, cast = "") => {
      updates.push(`${column} = $${n++}${cast}`);
      values.push(value);
    };

    if (payload.title !== undefined) set("title", payload.title.trim());
    if (payload.scope_description !== undefined) set("scope_description", payload.scope_description.trim());
    if (payload.agreed_price_excl_vat !== undefined) set("agreed_price_excl_vat", payload.agreed_price_excl_vat);
    if (vat) {
      set("vat_code", vat.code);
      set("vat_rate", vat.rate);
      set("vat_reverse_charge", vat.reverse_charge);
    }
    if (payload.planned_start !== undefined) set("planned_start", payload.planned_start, "::date");
    if (payload.planned_end !== undefined) set("planned_end", payload.planned_end, "::date");
    if (payload.work_address !== undefined) {
      const w = payload.work_address ? normalizeAddress(payload.work_address) : null;
      set("work_street", w?.street ?? null);
      set("work_house_number", w?.house_number ?? null);
      set("work_postcode", w?.postcode ?? null);
      set("work_city", w?.city ?? null);
      set("work_country", w?.country ?? null);
    }
    if (payload.language !== undefined) set("language", payload.language, `::"Language"`);
    if (payload.recipient_name !== undefined) set("recipient_name", clean(payload.recipient_name));
    if (payload.recipient_email !== undefined) set("recipient_email", clean(payload.recipient_email)?.toLowerCase() ?? null);
    if (payload.internal_notes !== undefined) set("internal_notes", clean(payload.internal_notes));

    updates.push("updated_at = CURRENT_TIMESTAMP");
    await client.query(`UPDATE subcontract_assignments SET ${updates.join(", ")} WHERE id = $1::uuid`, values);

    // A changed period on a sent assignment is something the subcontractor needs to know
    if (light && (payload.planned_start !== undefined || payload.planned_end !== undefined)) {
      await logAssignmentEvent(client, a.subcontractor_id, id, "ASSIGNMENT_RESCHEDULED", `Assignment ${a.number} rescheduled to ${start ?? "?"} - ${end ?? "?"}`, actorId);
    }
    await logAudit({ actor_id: actorId, action: "UPDATE", entity_type: "subcontract_assignment", entity_id: id, changes: { fields: Object.keys(payload) } }, client);
  });

  return readAssignment(id);
};

const deleteAssignment = async (id: string, actorId: string) => {
  await transaction(async (client) => {
    const a = await lockAssignment(client, id);
    if (a.status !== "DRAFT" || a.number) {
      throw new ApiError(httpStatus.CONFLICT, "Only a draft that was never sent can be deleted. Cancel the assignment instead!");
    }
    await client.query(`DELETE FROM subcontract_assignments WHERE id = $1::uuid`, [id]);
    await logAudit({ actor_id: actorId, action: "DELETE", entity_type: "subcontract_assignment", entity_id: id, changes: { title: a.title } }, client);
  });
};

// ---------------------------------------------------------------------------
// Sending the work instruction (FR-SUB-02)
// ---------------------------------------------------------------------------

const pdfInput = (view: any, number: string) => ({
  number,
  title: view.title,
  subcontractor: {
    name: view.subcontractor.name,
    contact_name: view.recipient_name && view.recipient_name !== view.subcontractor.name ? view.recipient_name : null,
  },
  project: { number: view.project.number, title: view.project.title },
  address_lines: view.work_address
    ? [
        [view.work_address.street, view.work_address.house_number].filter(Boolean).join(" "),
        [view.work_address.postcode, view.work_address.city].filter(Boolean).join(" "),
      ].filter(Boolean)
    : [],
  planned_start: view.planned_start,
  planned_end: view.planned_end,
  scope_description: view.scope_description,
  agreed_price_excl_vat: view.agreed_price_excl_vat,
  vat_reverse_charge: view.vat_reverse_charge,
});

// Draft / Sent / Declined -> Sent. The first time it gets its number; the PDF is made again every
// time (the scope or the dates may have changed). A repeated send is a reminder; sending after a
// decline is a new offer, so the earlier answer is cleared. The email goes out after the state
// is saved: if it fails the assignment stays Sent and can be sent again.
const sendAssignment = async (id: string, emailOverride: string | undefined, actorId: string) => {
  assertUuid(id, "assignment id");
  const company = await SettingsService.getCompanySettings();
  const logo = await loadLogo(company.logo_url);

  // Check what we can before using up a document number
  const peek = await query(`SELECT status, recipient_email, subcontractor_id FROM subcontract_assignments WHERE id = $1::uuid`, [id]);
  if (peek.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Assignment not found!");
  }
  if (!["DRAFT", "SENT", "DECLINED"].includes(peek.rows[0].status)) {
    throw new ApiError(httpStatus.CONFLICT, "Only a draft, sent or declined assignment can be sent!");
  }
  const sub = await query(`SELECT email FROM relations WHERE id = $1::uuid`, [peek.rows[0].subcontractor_id]);
  const to = clean(emailOverride)?.toLowerCase() ?? peek.rows[0].recipient_email ?? sub.rows[0]?.email;
  if (!to) {
    throw new ApiError(httpStatus.BAD_REQUEST, "There is no email address to send this to!");
  }

  await transaction(async (client) => {
    const a = await lockAssignment(client, id);
    if (!["DRAFT", "SENT", "DECLINED"].includes(a.status)) {
      throw new ApiError(httpStatus.CONFLICT, "Only a draft, sent or declined assignment can be sent!");
    }
    await loadSupplier(client, a.subcontractor_id, true, "SUBCONTRACTOR");
    await loadProject(client, a.project_id);

    const number = a.number ?? (await SettingsService.nextDocumentNumber("assignment", client));
    await client.query(
      `
        UPDATE subcontract_assignments
        SET number = $2, status = 'SENT', sent_at = CURRENT_TIMESTAMP, sent_to = NULL,
            responded_at = NULL, response_via = NULL, response_comment = NULL, proposed_start = NULL, proposed_end = NULL,
            response_recorded_by = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [id, number],
    );

    const view = await readAssignment(id, client);
    const pdf = await buildAssignmentPdf(pdfInput(view, number), company, toLanguage(view.language), { logo });
    await client.query(`UPDATE subcontract_assignments SET pdf_data = $2 WHERE id = $1::uuid`, [id, pdf]);

    await logAssignmentEvent(
      client,
      a.subcontractor_id,
      id,
      a.status === "DRAFT" ? "ASSIGNMENT_SENT" : a.status === "DECLINED" ? "ASSIGNMENT_RESENT" : "ASSIGNMENT_REMINDER",
      a.status === "DRAFT" ? `Assignment ${number} sent (${formatMoney(view.agreed_price_excl_vat, "EN")} excl. VAT)` : `Assignment ${number} sent again`,
      actorId,
      { metadata: { project_id: a.project_id } },
    );
    // The subcontractor now has a chat channel with the office on this project
    await ensureChannels(a.project_id, client);
    await logAudit(
      { actor_id: actorId, action: "STATUS_CHANGE", entity_type: "subcontract_assignment", entity_id: id, changes: { from: a.status, to: "SENT", number } },
      client,
    );
  });

  // The subcontractor's chat channel appears in the lists of the people who may see it, live
  await announceProject((await query(`SELECT project_id FROM subcontract_assignments WHERE id = $1::uuid`, [id])).rows[0]?.project_id);

  const view = await readAssignment(id);
  const language: TLanguage = toLanguage(view.language);
  const pdf = (await query(`SELECT pdf_data FROM subcontract_assignments WHERE id = $1::uuid`, [id])).rows[0].pdf_data as Buffer;
  const planned = (day: string | null) => (day ? formatDate(`${day}T12:00:00Z`, language) : "-");

  let delivery: { sent: boolean; to?: string; error?: string };
  try {
    await sendTemplatedEmail({
      to,
      templateKey: "subcontract_assignment",
      language,
      variables: {
        name: view.recipient_name ?? view.subcontractor.name,
        assignment_number: view.number,
        project: `${view.project.number} ${view.project.title}`,
        planned_start: planned(view.planned_start),
        planned_end: planned(view.planned_end),
        price: formatMoney(view.agreed_price_excl_vat, language),
        link: portalUrl(id),
      },
      attachments: [{ filename: `${view.number}.pdf`, content: pdf, contentType: "application/pdf" }],
      related: { type: "subcontract_assignment", id },
      sentBy: actorId,
    });
    await query(`UPDATE subcontract_assignments SET sent_to = $2 WHERE id = $1::uuid`, [id, to]);
    delivery = { sent: true, to };
  } catch (error: any) {
    delivery = { sent: false, error: error?.message ?? "Sending failed" };
  }

  return { ...(await readAssignment(id)), delivery };
};

const getPdf = async (id: string) => {
  assertUuid(id, "assignment id");
  const found = await query(`SELECT id, number, pdf_data FROM subcontract_assignments WHERE id = $1::uuid`, [id]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Assignment not found!");
  }
  const row = found.rows[0];
  if (row.pdf_data) return { pdf: row.pdf_data as Buffer, filename: `${row.number}.pdf` };

  // A draft gets a preview (not stored)
  const company = await SettingsService.getCompanySettings();
  const logo = await loadLogo(company.logo_url);
  const view = await readAssignment(id);
  const pdf = await buildAssignmentPdf(pdfInput(view, "DRAFT"), company, toLanguage(view.language), { logo });
  return { pdf, filename: "work-instruction-draft.pdf" };
};

// ---------------------------------------------------------------------------
// The subcontractor's answer, progress and completion (FR-SUB-03, FR-SUB-04)
// ---------------------------------------------------------------------------

const respondAssignment = async (id: string, input: IRespondAssignment, actorId: string | null) => {
  await transaction(async (client) => {
    const a = await lockAssignment(client, id);
    if (a.status !== "SENT") {
      throw new ApiError(httpStatus.CONFLICT, "Only an assignment that was sent and not answered yet can be confirmed or declined!");
    }
    const confirm = input.response === "CONFIRM";
    await client.query(
      `
        UPDATE subcontract_assignments
        SET status = $2, responded_at = CURRENT_TIMESTAMP, response_via = $3, response_comment = $4,
            proposed_start = $5::date, proposed_end = $6::date, response_recorded_by = $7::uuid, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
      `,
      [
        id,
        confirm ? "CONFIRMED" : "DECLINED",
        input.via ?? "OTHER",
        clean(input.comment),
        confirm ? null : (input.proposed_start ?? null),
        confirm ? null : (input.proposed_end ?? null),
        actorId,
      ],
    );
    await logAssignmentEvent(
      client,
      a.subcontractor_id,
      id,
      confirm ? "ASSIGNMENT_CONFIRMED" : "ASSIGNMENT_DECLINED",
      `Assignment ${a.number} ${confirm ? "confirmed" : "declined"} by the subcontractor (${input.via ?? "OTHER"})`,
      actorId,
      { description: clean(input.comment), metadata: confirm ? {} : { proposed_start: input.proposed_start ?? null, proposed_end: input.proposed_end ?? null } },
    );
    await logAudit(
      { actor_id: actorId, action: "STATUS_CHANGE", entity_type: "subcontract_assignment", entity_id: id, changes: { to: confirm ? "CONFIRMED" : "DECLINED", via: input.via ?? "OTHER" } },
      client,
    );
  });
  // The office user who made the assignment hears the answer (the person who recorded it knows)
  const answered = await readAssignment(id);
  await notify([answered.created_by], {
    type: "ASSIGNMENT_RESPONSE",
    title: `${answered.subcontractor.name} ${input.response === "CONFIRM" ? "confirmed" : "declined"} assignment ${answered.number}`,
    body: clean(input.comment),
    entity: { type: "subcontract_assignment", id },
    actorId,
  });
  return answered;
};

const reportProgress = async (id: string, input: IProgressInput, actorId: string | null) => {
  await transaction(async (client) => {
    const a = await lockAssignment(client, id);
    if (a.status !== "CONFIRMED") {
      throw new ApiError(httpStatus.CONFLICT, "Progress can only be reported on a confirmed assignment!");
    }
    await client.query(`INSERT INTO subcontract_progress (assignment_id, percent, note, reported_by) VALUES ($1::uuid, $2, $3, $4::uuid)`, [
      id,
      input.percent,
      clean(input.note),
      actorId,
    ]);
    await client.query(`UPDATE subcontract_assignments SET progress_percent = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id, input.percent]);
    await logAssignmentEvent(client, a.subcontractor_id, id, "ASSIGNMENT_PROGRESS", `Assignment ${a.number}: ${input.percent}% done`, actorId, {
      description: clean(input.note),
    });
  });
  return readAssignment(id);
};

// Confirmed -> Completed. If an approved invoice is already there, it is Invoiced straight away.
const completeAssignment = async (id: string, input: ICompleteAssignment, actorId: string | null) => {
  await transaction(async (client) => {
    const a = await lockAssignment(client, id);
    if (a.status !== "CONFIRMED") {
      throw new ApiError(httpStatus.CONFLICT, "Only a confirmed assignment can be completed!");
    }
    await client.query(
      `UPDATE subcontract_assignments SET status = 'COMPLETED', progress_percent = 100, completed_at = CURRENT_TIMESTAMP, completed_note = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, clean(input.note)],
    );
    if (a.progress_percent !== 100) {
      await client.query(`INSERT INTO subcontract_progress (assignment_id, percent, note, reported_by) VALUES ($1::uuid, 100, $2, $3::uuid)`, [id, clean(input.note), actorId]);
    }
    await logAssignmentEvent(client, a.subcontractor_id, id, "ASSIGNMENT_COMPLETED", `Assignment ${a.number} completed`, actorId, { description: clean(input.note) });
    await logAudit({ actor_id: actorId, action: "STATUS_CHANGE", entity_type: "subcontract_assignment", entity_id: id, changes: { to: "COMPLETED" } }, client);
    await syncAssignmentInvoiced(client, id, actorId);
  });
  return readAssignment(id);
};

// Completed -> Confirmed again (work was not finished after all). Not once it is Invoiced:
// unapprove or void the invoices first.
const reopenAssignment = async (id: string, reason: string | null | undefined, actorId: string) => {
  await transaction(async (client) => {
    const a = await lockAssignment(client, id);
    if (a.status === "INVOICED") {
      throw new ApiError(httpStatus.CONFLICT, "This assignment has approved invoices. Unapprove or void them before reopening!");
    }
    if (a.status !== "COMPLETED") {
      throw new ApiError(httpStatus.CONFLICT, "Only a completed assignment can be reopened!");
    }
    await client.query(`UPDATE subcontract_assignments SET status = 'CONFIRMED', completed_at = NULL, completed_note = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
    await logAssignmentEvent(client, a.subcontractor_id, id, "ASSIGNMENT_REOPENED", `Assignment ${a.number} reopened`, actorId, { description: clean(reason) });
    await logAudit({ actor_id: actorId, action: "STATUS_CHANGE", entity_type: "subcontract_assignment", entity_id: id, changes: { to: "CONFIRMED", reopened: true } }, client);
  });
  return readAssignment(id);
};

const cancelAssignment = async (id: string, reason: string, actorId: string) => {
  await transaction(async (client) => {
    const a = await lockAssignment(client, id);
    if (a.status === "DRAFT") {
      throw new ApiError(httpStatus.CONFLICT, "A draft is deleted, not cancelled!");
    }
    if (!["SENT", "CONFIRMED", "DECLINED"].includes(a.status)) {
      throw new ApiError(httpStatus.CONFLICT, a.status === "CANCELLED" ? "This assignment has already been cancelled!" : "A completed assignment cannot be cancelled. Reopen it first!");
    }
    const live = await client.query(`SELECT COUNT(*)::int AS n FROM supplier_invoices WHERE subcontract_assignment_id = $1::uuid AND status <> 'VOID'`, [id]);
    if (live.rows[0].n > 0) {
      throw new ApiError(httpStatus.CONFLICT, "This assignment has invoices. Void them before cancelling!");
    }
    await client.query(
      `UPDATE subcontract_assignments SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, reason.trim()],
    );
    await logAssignmentEvent(client, a.subcontractor_id, id, "ASSIGNMENT_CANCELLED", `Assignment ${a.number} cancelled`, actorId, { description: reason.trim() });
    await logAudit({ actor_id: actorId, action: "STATUS_CHANGE", entity_type: "subcontract_assignment", entity_id: id, changes: { to: "CANCELLED", reason: reason.trim() } }, client);
  });
  return readAssignment(id);
};

// ---------------------------------------------------------------------------
// The subcontractor's invoice (FR-SUB-04): recorded like any supplier invoice, linked to the
// assignment. Approving it makes the assignment Invoiced and counts as project cost.
// ---------------------------------------------------------------------------

const recordInvoice = async (id: string, input: any, actor: IActor) => {
  assertUuid(id, "assignment id");
  const found = await query(`SELECT subcontractor_id FROM subcontract_assignments WHERE id = $1::uuid`, [id]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Assignment not found!");
  }
  return SupplierInvoiceService.createSupplierInvoice(
    { ...input, supplier_id: found.rows[0].subcontractor_id, subcontract_assignment_id: id },
    actor,
  );
};

// ---------------------------------------------------------------------------
// Documents for the subcontractor (drawings, specifications, photos)
// ---------------------------------------------------------------------------

const addFiles = async (id: string, files: any[], fields: Record<string, any>, actorId: string | null) => {
  assertUuid(id, "assignment id");
  const found = await query(`SELECT project_id, subcontractor_id, number, status FROM subcontract_assignments WHERE id = $1::uuid`, [id]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Assignment not found!");
  }
  const a = found.rows[0];
  if (a.status === "CANCELLED") {
    throw new ApiError(httpStatus.CONFLICT, "A cancelled assignment cannot get new files!");
  }
  // Shared with the subcontractor unless said otherwise
  const saved = await ProjectService.addFiles(
    a.project_id,
    files,
    { ...fields, share_with_subcontractor: fields.share_with_subcontractor ?? true },
    actorId,
    { assignmentId: id, defaultFolder: "GENERAL" },
  );
  await logAssignmentEvent(
    { query }, // outside a transaction: a plain query is enough for a timeline note
    a.subcontractor_id,
    id,
    "ASSIGNMENT_FILES_ADDED",
    `${saved.length} file${saved.length === 1 ? "" : "s"} added to assignment ${a.number ?? "(draft)"}`,
    actorId,
  );
  return saved;
};

const deleteFile = async (id: string, fileId: string, actorId: string) => {
  assertUuid(id, "assignment id");
  assertUuid(fileId, "file id");
  const found = await query(
    `SELECT f.project_id FROM project_files f WHERE f.id = $1::uuid AND f.subcontract_assignment_id = $2::uuid`,
    [fileId, id],
  );
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "File not found!");
  }
  await ProjectService.deleteFile(found.rows[0].project_id, fileId, actorId);
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const getHistory = async (id: string, params: Record<string, any>) => {
  assertUuid(id, "assignment id");
  const exists = await query(`SELECT 1 FROM subcontract_assignments WHERE id = $1::uuid`, [id]);
  if (exists.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Assignment not found!");
  }

  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const scope = `t.entity_type = 'subcontract_assignment' AND t.entity_id = $1::uuid`;
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

export const SubcontractingService = {
  createAssignment,
  getAllAssignments,
  getSchedule,
  getAssignmentById,
  updateAssignment,
  deleteAssignment,
  sendAssignment,
  getPdf,
  respondAssignment,
  reportProgress,
  completeAssignment,
  reopenAssignment,
  cancelAssignment,
  recordInvoice,
  addFiles,
  deleteFile,
  getHistory,
};
