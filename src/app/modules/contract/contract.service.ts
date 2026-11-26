import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { addDays, amsterdamToday, isValidDay } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { SettingsService } from "../settings/settings.service";
import { DirectDebitService } from "./contract.directdebit.service";
import {
  ICreateContract,
  IEndContract,
  IUpdateContract,
} from "./contract.interface";
import {
  clean,
  contractColumns,
  dayOfMonth,
  loadContract,
  loadCustomer,
  logContractEvent,
  nextBillingDate,
  visitDatesBetween,
} from "./contract.shared";
import { toLanguage } from "../../utils/i18n";

// Abonnementen (SRS 4.15): recurring maintenance contracts. A contract is billed in advance on
// each billing date by the billing job (contract.jobs.ts). Every change applies from the next
// billing date, because invoices are made from the contract as it is on that day (FR-ABO-07).

const assertDay = (value: any, label: string) => {
  if (typeof value !== "string" || !isValidDay(value)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `${label} must be a date like 2026-12-31!`,
    );
  }
};

const assertVatCode = async (code: string) => {
  const company = await SettingsService.getCompanySettings();
  if (!(company.vat_rates as { code: string }[]).some((v) => v.code === code)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Unknown VAT code!");
  }
};

// People who can be sent to a maintenance visit: active office and field users
const assertVisitAssignees = async (ids: string[] | undefined) => {
  if (!ids || ids.length === 0) return [] as string[];
  const unique = [...new Set(ids)];
  unique.forEach((id) => assertUuid(id, "user id"));
  const found = await query(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_active AND status = 'ACTIVE' AND role::text IN ('ADMIN', 'OFFICE', 'FIELD')`,
    [unique],
  );
  if (found.rows.length !== unique.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "A visit can only be given to active office or field users!",
    );
  }
  return unique;
};

const normalizeAddress = (a: any) => ({
  street: String(a.street).trim(),
  house_number: String(a.house_number).trim(),
  postcode: String(a.postcode)
    .trim()
    .toUpperCase()
    .replace(/^(\d{4})\s?([A-Z]{2})$/, "$1 $2"),
  city: String(a.city).trim(),
  country: String(a.country ?? "NL").toUpperCase(),
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const listJoins = `
  JOIN relations r ON r.id = s.relation_id
  LEFT JOIN relation_direct_debit dd ON dd.relation_id = s.relation_id AND dd.mandate_status = 'valid'
`;
const listColumns = `
  ${contractColumns},
  json_build_object('id', r.id, 'name', r.name, 'type', r.type) AS relation,
  (s.use_direct_debit AND dd.relation_id IS NOT NULL) AS direct_debit_active,
  CASE WHEN s.use_direct_debit AND dd.relation_id IS NOT NULL THEN 'DIRECT_DEBIT' ELSE 'PAYMENT_LINK' END AS collection
`;

// The list shows only the main facts; the detail (GET /contracts/:id) has everything
const summaryColumns = `
  s.id, s.number, s.title, s.status,
  json_build_object('id', r.id, 'name', r.name, 'type', r.type) AS relation,
  s.amount_excl_vat::float8 AS amount_excl_vat, s.vat_code, s.billing_interval,
  to_char(s.start_date, 'YYYY-MM-DD') AS start_date, to_char(s.end_date, 'YYYY-MM-DD') AS end_date,
  to_char(s.next_billing_date, 'YYYY-MM-DD') AS next_billing_date,
  CASE WHEN s.use_direct_debit AND dd.relation_id IS NOT NULL THEN 'DIRECT_DEBIT' ELSE 'PAYMENT_LINK' END AS collection
`;

const sortable: Record<string, string> = {
  created_at: "s.created_at",
  number: "s.number",
  next_billing_date: "s.next_billing_date",
  amount_excl_vat: "s.amount_excl_vat",
  title: "s.title",
};

const getAll = async (params: Record<string, any>) => {
  const { page, limit, skip, sortBy, sortOrder } =
    paginationHelper.calculatePagination(params as any);
  const where: string[] = [];
  const values: any[] = [];
  const push = (v: any) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (params.status) {
    const list = String(params.status)
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
    where.push(`s.status = ANY(${push(list)}::text[])`);
  }
  if (params.relation_id) {
    assertUuid(String(params.relation_id), "relation id");
    where.push(`s.relation_id = ${push(params.relation_id)}::uuid`);
  }
  if (params.billing_interval)
    where.push(
      `s.billing_interval = ${push(String(params.billing_interval).toUpperCase())}`,
    );
  if (params.due_within_days !== undefined) {
    const days = Number(params.due_within_days);
    if (!Number.isInteger(days) || days < 0 || days > 366)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "due_within_days must be between 0 and 366!",
      );
    where.push(
      `s.status = 'ACTIVE' AND s.next_billing_date <= ${push(addDays(amsterdamToday(), days))}::date`,
    );
  }
  if (params.searchTerm) {
    const term = `%${String(params.searchTerm)
      .trim()
      .replace(/[%_\\]/g, "\\$&")}%`;
    const p = push(term);
    where.push(
      `(s.number ILIKE ${p} OR s.title ILIKE ${p} OR r.name ILIKE ${p})`,
    );
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderColumn = sortable[sortBy] ?? sortable.created_at;
  const direction = String(sortOrder).toLowerCase() === "asc" ? "ASC" : "DESC";

  const [rows, count] = await Promise.all([
    query(
      `SELECT ${summaryColumns} FROM subscriptions s ${listJoins} ${clause}
       ORDER BY ${orderColumn} ${direction} NULLS LAST, s.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, skip],
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM subscriptions s ${listJoins} ${clause}`,
      values,
    ),
  ]);
  const total = count.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: rows.rows,
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

const getById = async (id: string) => {
  assertUuid(id, "subscription id");
  const found = await query(
    `SELECT ${listColumns} FROM subscriptions s ${listJoins} WHERE s.id = $1::uuid`,
    [id],
  );
  if (found.rows.length === 0)
    throw new ApiError(httpStatus.NOT_FOUND, "Subscription not found!");
  const contract = found.rows[0];
  const today = amsterdamToday();

  const [invoices, billings, visits, directDebit] = await Promise.all([
    query(
      `
        SELECT i.id, i.number, i.status, i.payment_status, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
               to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.total_incl_vat::float8 AS total_incl_vat,
               i.paid_amount::float8 AS paid_amount, i.sent_at
        FROM invoices i WHERE i.subscription_id = $1::uuid ORDER BY i.created_at DESC LIMIT 24
      `,
      [id],
    ),
    query(
      `
        SELECT b.id, to_char(b.period_start, 'YYYY-MM-DD') AS period_start, to_char(b.period_end, 'YYYY-MM-DD') AS period_end,
               b.status, b.collection, b.invoice_id, b.created_at AS "createdAt"
        FROM subscription_billings b WHERE b.subscription_id = $1::uuid ORDER BY b.period_start DESC LIMIT 24
      `,
      [id],
    ),
    query(
      `
        SELECT to_char(v.visit_date, 'YYYY-MM-DD') AS visit_date, v.appointment_id, a.status AS appointment_status
        FROM subscription_visits v LEFT JOIN appointments a ON a.id = v.appointment_id
        WHERE v.subscription_id = $1::uuid AND v.visit_date >= $2::date - 30 ORDER BY v.visit_date ASC LIMIT 24
      `,
      [id, today],
    ),
    DirectDebitService.getStatus(contract.relation_id),
  ]);

  const upcomingVisits =
    contract.status === "ACTIVE" && contract.visits_per_year > 0
      ? visitDatesBetween(
          contract.first_visit_date,
          contract.visits_per_year,
          today,
          addDays(today, 400),
        )
          .filter((d) => !contract.end_date || d <= contract.end_date)
          .slice(0, 4)
      : [];

  return {
    ...contract,
    invoices: invoices.rows,
    billings: billings.rows,
    visits: visits.rows,
    upcoming_visit_dates: upcomingVisits,
    direct_debit: directDebit,
    can_edit: contract.status !== "ENDED",
    can_pause: contract.status === "ACTIVE",
    can_resume: contract.status === "PAUSED",
    can_end: contract.status !== "ENDED",
  };
};

const getInvoices = async (id: string) => {
  await loadContract(id);
  const result = await query(
    `SELECT id, number, status, payment_status, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(due_date, 'YYYY-MM-DD') AS due_date,
            total_incl_vat::float8 AS total_incl_vat, paid_amount::float8 AS paid_amount
     FROM invoices WHERE subscription_id = $1::uuid ORDER BY created_at DESC`,
    [id],
  );
  return result.rows;
};

const getHistory = async (id: string, params: Record<string, any>) => {
  await loadContract(id);
  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );
  const scope = `t.entity_type = 'subscription' AND t.entity_id = $1::uuid`;
  const [rows, count] = await Promise.all([
    query(
      `SELECT t.id, t.event_type, t.title, t.description, t.metadata, t.actor_id, u.name AS actor_name, t.created_at AS "createdAt"
       FROM relation_timeline t LEFT JOIN users u ON u.id = t.actor_id WHERE ${scope}
       ORDER BY t.created_at DESC, t.id DESC LIMIT $2 OFFSET $3`,
      [id, limit, skip],
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM relation_timeline t WHERE ${scope}`,
      [id],
    ),
  ]);
  const total = count.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: rows.rows,
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

// Numbers for the dashboard tile and the overview page
const getSummary = async () => {
  const today = amsterdamToday();
  const [counts, dd, due] = await Promise.all([
    query(
      `
        SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
               COUNT(*) FILTER (WHERE status = 'PAUSED')::int AS paused,
               COUNT(*) FILTER (WHERE status = 'ENDED')::int AS ended,
               COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN amount_excl_vat * (12.0 / CASE billing_interval WHEN 'MONTHLY' THEN 1 WHEN 'QUARTERLY' THEN 3 ELSE 12 END) END), 0)::float8 AS yearly_recurring_excl_vat
        FROM subscriptions
      `,
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM subscriptions s JOIN relation_direct_debit dd ON dd.relation_id = s.relation_id AND dd.mandate_status = 'valid'
       WHERE s.status = 'ACTIVE' AND s.use_direct_debit`,
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM subscriptions WHERE status = 'ACTIVE' AND next_billing_date <= $1::date`,
      [addDays(today, 7)],
    ),
  ]);
  const failed = await query(
    `SELECT COUNT(*)::int AS n FROM actions WHERE auto_type = 'direct_debit_failed' AND status = 'OPEN'`,
  );
  return {
    ...counts.rows[0],
    yearly_recurring_excl_vat:
      Math.round(counts.rows[0].yearly_recurring_excl_vat * 100) / 100,
    with_direct_debit: dd.rows[0].n,
    billing_within_7_days: due.rows[0].n,
    failed_direct_debits_open: failed.rows[0].n,
  };
};

// ---------------------------------------------------------------------------
// Creating and editing (FR-ABO-01, FR-ABO-07)
// ---------------------------------------------------------------------------

const createContract = async (input: ICreateContract, actorId: string) => {
  const relation = await loadCustomer(input.relation_id);
  assertDay(input.start_date, "Start date");
  if (input.end_date) {
    assertDay(input.end_date, "End date");
    if (input.end_date < input.start_date)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "The end date cannot be before the start date!",
      );
  }
  const vatCode = input.vat_code ?? "21";
  await assertVatCode(vatCode);

  const visitsPerYear = input.visits_per_year ?? 0;
  if (visitsPerYear > 0) {
    if (!input.first_visit_date)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "The first visit date is required when visits are planned!",
      );
    assertDay(input.first_visit_date, "First visit date");
  }
  const assignees = await assertVisitAssignees(input.visit_assignee_ids);

  // The object address: given, or the customer's billing address when it is complete
  let address: any = null;
  if (input.address) address = normalizeAddress(input.address);
  else if (
    input.address === undefined &&
    relation.billing_street &&
    relation.billing_house_number &&
    relation.billing_postcode &&
    relation.billing_city
  ) {
    address = normalizeAddress({
      street: relation.billing_street,
      house_number: relation.billing_house_number,
      postcode: relation.billing_postcode,
      city: relation.billing_city,
      country: relation.billing_country,
    });
  }

  const id = await transaction(async (client) => {
    const number = await SettingsService.nextDocumentNumber(
      "subscription",
      client,
    );
    const inserted = await client.query(
      `
        INSERT INTO subscriptions (
          number, relation_id, title, description, street, house_number, postcode, city, country,
          amount_excl_vat, vat_code, billing_interval, start_date, end_date, anchor_day, next_billing_date,
          payment_term_days, use_direct_debit, language, visits_per_year, first_visit_date, visit_assignee_ids,
          internal_notes, created_by
        ) VALUES (
          $1, $2::uuid, $3, $4, $5, $6, $7, $8, COALESCE($9, 'NL'),
          $10, $11, $12, $13::date, $14::date, $15, $13::date,
          $16, $17, $18::"Language", $19, $20::date, $21::uuid[],
          $22, $23::uuid
        ) RETURNING id, number, relation_id
      `,
      [
        number,
        input.relation_id,
        input.title.trim().slice(0, 255),
        clean(input.description),
        address?.street ?? null,
        address?.house_number ?? null,
        address?.postcode ?? null,
        address?.city ?? null,
        address?.country ?? null,
        input.amount_excl_vat,
        vatCode,
        input.billing_interval,
        input.start_date,
        input.end_date ?? null,
        dayOfMonth(input.start_date),
        input.payment_term_days ?? 14,
        input.use_direct_debit ?? true,
        input.language ?? toLanguage(relation.preferred_language),
        visitsPerYear,
        visitsPerYear > 0 ? input.first_visit_date : null,
        assignees,
        clean(input.internal_notes),
        actorId,
      ],
    );
    const created = inserted.rows[0];
    await logContractEvent(
      created,
      "SUBSCRIPTION_CREATED",
      `Maintenance contract ${created.number} created`,
      actorId,
      { interval: input.billing_interval },
      client,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "CREATE",
        entity_type: "subscription",
        entity_id: created.id,
        changes: {
          number: created.number,
          amount_excl_vat: input.amount_excl_vat,
        },
      },
      client,
    );
    return created.id as string;
  });
  return getById(id);
};

const updateContract = async (
  id: string,
  input: IUpdateContract,
  actorId: string,
) => {
  const current = await loadContract(id);
  if (current.status === "ENDED")
    throw new ApiError(
      httpStatus.CONFLICT,
      "An ended contract cannot be changed!",
    );

  const updates: string[] = [];
  const values: any[] = [];
  const set = (column: string, value: any, cast = "") => {
    values.push(value);
    updates.push(`${column} = $${values.length}${cast}`);
  };
  const changes: Record<string, any> = {};

  if (input.title !== undefined) {
    set("title", input.title.trim().slice(0, 255));
    changes.title = input.title;
  }
  if (input.description !== undefined)
    set("description", clean(input.description));
  if (input.internal_notes !== undefined)
    set("internal_notes", clean(input.internal_notes));
  if (input.amount_excl_vat !== undefined) {
    set("amount_excl_vat", input.amount_excl_vat);
    changes.amount_excl_vat = {
      from: current.amount_excl_vat,
      to: input.amount_excl_vat,
    };
  }
  if (input.vat_code !== undefined) {
    await assertVatCode(input.vat_code);
    set("vat_code", input.vat_code);
    changes.vat_code = input.vat_code;
  }
  if (input.billing_interval !== undefined) {
    set("billing_interval", input.billing_interval);
    changes.billing_interval = {
      from: current.billing_interval,
      to: input.billing_interval,
    };
  }
  if (input.payment_term_days !== undefined)
    set("payment_term_days", input.payment_term_days);
  if (input.use_direct_debit !== undefined) {
    set("use_direct_debit", input.use_direct_debit);
    changes.use_direct_debit = input.use_direct_debit;
  }
  if (input.language !== undefined)
    set("language", input.language, `::"Language"`);
  if (input.end_date !== undefined) {
    if (input.end_date !== null) {
      assertDay(input.end_date, "End date");
      if (input.end_date < current.start_date)
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          "The end date cannot be before the start date!",
        );
      if (input.end_date < amsterdamToday())
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          "The end date cannot be in the past. End the contract instead!",
        );
    }
    set("end_date", input.end_date, "::date");
    changes.end_date = input.end_date;
  }
  if (input.address !== undefined) {
    const a = input.address ? normalizeAddress(input.address) : null;
    set("street", a?.street ?? null);
    set("house_number", a?.house_number ?? null);
    set("postcode", a?.postcode ?? null);
    set("city", a?.city ?? null);
    set("country", a?.country ?? "NL");
  }

  // Visits: the schedule is worked out from these, so a change only affects visits not made yet
  const visitsPerYear = input.visits_per_year ?? current.visits_per_year;
  const firstVisit =
    input.first_visit_date !== undefined
      ? input.first_visit_date
      : current.first_visit_date;
  if (
    input.visits_per_year !== undefined ||
    input.first_visit_date !== undefined
  ) {
    if (visitsPerYear > 0 && !firstVisit)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "The first visit date is required when visits are planned!",
      );
    if (firstVisit) assertDay(firstVisit, "First visit date");
    set("visits_per_year", visitsPerYear);
    set("first_visit_date", visitsPerYear > 0 ? firstVisit : null, "::date");
    changes.visits_per_year = visitsPerYear;
  }
  if (input.visit_assignee_ids !== undefined)
    set(
      "visit_assignee_ids",
      await assertVisitAssignees(input.visit_assignee_ids),
      "::uuid[]",
    );

  if (updates.length === 0)
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  updates.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  await transaction(async (client) => {
    await client.query(
      `UPDATE subscriptions SET ${updates.join(", ")} WHERE id = $${values.length}::uuid`,
      values,
    );
    await logContractEvent(
      current,
      "SUBSCRIPTION_UPDATED",
      `Maintenance contract ${current.number} changed (applies from the next billing date)`,
      actorId,
      { changes },
      client,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "subscription",
        entity_id: id,
        changes,
      },
      client,
    );
  });
  return getById(id);
};

// ---------------------------------------------------------------------------
// Pause, resume, end (FR-ABO-07)
// ---------------------------------------------------------------------------

const lock = async (client: any, id: string) => {
  assertUuid(id, "subscription id");
  const r = await client.query(
    `SELECT id, number, relation_id, status, billing_interval, anchor_day, to_char(next_billing_date, 'YYYY-MM-DD') AS next_billing_date,
            to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
     FROM subscriptions WHERE id = $1::uuid FOR UPDATE`,
    [id],
  );
  if (r.rows.length === 0)
    throw new ApiError(httpStatus.NOT_FOUND, "Subscription not found!");
  return r.rows[0];
};

const pauseContract = async (id: string, actorId: string) => {
  await transaction(async (client) => {
    const c = await lock(client, id);
    if (c.status !== "ACTIVE")
      throw new ApiError(
        httpStatus.CONFLICT,
        "Only an active contract can be paused!",
      );
    await client.query(
      `UPDATE subscriptions SET status = 'PAUSED', paused_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id],
    );
    await logContractEvent(
      c,
      "SUBSCRIPTION_PAUSED",
      `Maintenance contract ${c.number} paused`,
      actorId,
      {},
      client,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "subscription",
        entity_id: id,
        changes: { status: "PAUSED" },
      },
      client,
    );
  });
  return getById(id);
};

// Periods that passed while paused are not billed: billing carries on from the next billing date
const resumeContract = async (id: string, actorId: string) => {
  const skipped = await transaction(async (client) => {
    const c = await lock(client, id);
    if (c.status !== "PAUSED")
      throw new ApiError(
        httpStatus.CONFLICT,
        "Only a paused contract can be resumed!",
      );
    const today = amsterdamToday();
    let next = c.next_billing_date as string;
    let skippedPeriods = 0;
    while (next < today && skippedPeriods < 1200) {
      next = nextBillingDate(next, c.billing_interval, c.anchor_day);
      skippedPeriods++;
    }
    await client.query(
      `UPDATE subscriptions SET status = 'ACTIVE', paused_at = NULL, next_billing_date = $2::date, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [id, next],
    );
    await logContractEvent(
      c,
      "SUBSCRIPTION_RESUMED",
      `Maintenance contract ${c.number} resumed (next billing date ${next})`,
      actorId,
      { next_billing_date: next, skipped_periods: skippedPeriods },
      client,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "subscription",
        entity_id: id,
        changes: { status: "ACTIVE", next_billing_date: next },
      },
      client,
    );
    return skippedPeriods;
  });
  return { ...(await getById(id)), skipped_periods: skipped };
};

// The end date is the last day the contract runs: a billing period that starts on or before it is
// still billed, none after. It becomes ENDED at once when nothing more is to be billed, otherwise
// when the billing job has made the last invoice.
const endContract = async (
  id: string,
  input: IEndContract,
  actorId: string,
) => {
  await transaction(async (client) => {
    const c = await lock(client, id);
    if (c.status === "ENDED")
      throw new ApiError(
        httpStatus.CONFLICT,
        "This contract has already ended!",
      );
    const today = amsterdamToday();
    const endDate = input.end_date ?? today;
    assertDay(endDate, "End date");
    if (endDate < c.start_date)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "The end date cannot be before the start date!",
      );
    if (endDate < today)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "The end date cannot be in the past!",
      );

    const nothingMoreToBill =
      c.status === "PAUSED" ||
      !c.next_billing_date ||
      c.next_billing_date > endDate;
    await client.query(
      `UPDATE subscriptions
       SET end_date = $2::date, end_reason = $3,
           status = CASE WHEN $4 THEN 'ENDED' ELSE status END,
           ended_at = CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE ended_at END,
           next_billing_date = CASE WHEN $4 THEN NULL ELSE next_billing_date END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1::uuid`,
      [id, endDate, clean(input.reason), nothingMoreToBill],
    );
    await logContractEvent(
      c,
      "SUBSCRIPTION_ENDED",
      `Maintenance contract ${c.number} ${nothingMoreToBill ? "ended" : `ends on ${endDate}`}`,
      actorId,
      { end_date: endDate, reason: clean(input.reason) },
      client,
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "subscription",
        entity_id: id,
        changes: {
          end_date: endDate,
          status: nothingMoreToBill ? "ENDED" : c.status,
        },
      },
      client,
    );
  });
  return getById(id);
};

export const ContractService = {
  getAll,
  getById,
  getInvoices,
  getHistory,
  getSummary,
  createContract,
  updateContract,
  pauseContract,
  resumeContract,
  endContract,
};
