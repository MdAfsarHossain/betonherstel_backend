import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { addDays, amsterdamToday, isValidDay } from "../../utils/dates";
import { query } from "../../utils/db";
import { recordLabelSql } from "../../utils/records";
import { ActionService } from "../actions/actions.service";
import { ContractService } from "../contract/contract.service";
import { NotificationService } from "../messages/notification.service";
import { PlanningService } from "../planning/planning.service";
import { WorkOrderService } from "../workorder/workorder.service";

// Dashboard (SRS 4.2). One call gives the start page: summary tiles with counts and links
// (FR-DASH-01), new inquiries highlighted until opened (FR-DASH-02), the value of open projects
// and unpaid invoices for the Beheerder (FR-DASH-03), warnings (FR-DASH-06), and the recent events
// feed (FR-DASH-04). Field crew get a simplified day view instead (FR-DASH-05).
// It only reads: every number comes from the module that owns the data.

export interface IDashActor {
  id: string;
  role: string;
}

const todaySql = `(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Amsterdam')::date`;
const isAdmin = (actor: IDashActor) =>
  ["SUPERADMIN", "ADMIN"].includes(actor.role);
const r2 = (n: number) => Math.round(n * 100) / 100;

// The events the feed shows by default (FR-DASH-04); `scope=all` shows every event
const keyEvents: { type: string; category: string }[] = [
  { type: "INQUIRY_CREATED", category: "inquiry" },
  { type: "QUOTE_SENT", category: "quote" },
  { type: "QUOTE_ACCEPTED", category: "quote" },
  { type: "INVOICE_ISSUED", category: "invoice" },
  { type: "INVOICE_PAYMENT_RECEIVED", category: "invoice" },
  { type: "WORK_ORDER_COMPLETED", category: "work_order" },
];

const categoryOf = (eventType: string) => {
  const known = keyEvents.find((e) => e.type === eventType);
  if (known) return known.category;
  const prefix = eventType.split("_")[0].toLowerCase();
  return prefix === "work" ? "work_order" : prefix;
};

// ---------------------------------------------------------------------------
// The office dashboard
// ---------------------------------------------------------------------------

const getTiles = async (actor: IDashActor) => {
  const [
    actions,
    notifications,
    workOrders,
    inquiries,
    quotes,
    projects,
    subscriptions,
  ] = await Promise.all([
    ActionService.getSummary(actor),
    NotificationService.getSummary(actor.id),
    query(
      `
        SELECT COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
               COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
               COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS awaiting_check,
               COUNT(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS') AND planned_date = ${todaySql})::int AS planned_today
        FROM work_orders
      `,
    ),
    query(
      `
        SELECT COUNT(*) FILTER (WHERE s.kind = 'NEW')::int AS new,
               COUNT(*) FILTER (WHERE s.kind IN ('NEW', 'OPEN'))::int AS open,
               COUNT(*) FILTER (WHERE s.kind IN ('NEW', 'OPEN') AND i.assigned_to IS NULL)::int AS unassigned
        FROM inquiries i JOIN inquiry_statuses s ON s.id = i.status_id
      `,
    ),
    query(
      `
        SELECT COUNT(*) FILTER (WHERE status = 'DRAFT' AND is_current)::int AS draft,
               COUNT(*) FILTER (WHERE status = 'SENT' AND is_current)::int AS awaiting_answer,
               COUNT(*) FILTER (WHERE status = 'SENT' AND is_current AND valid_until BETWEEN ${todaySql} AND ${todaySql} + 7)::int AS expiring_soon,
               COUNT(*) FILTER (WHERE status = 'ACCEPTED' AND is_current AND accepted_at >= CURRENT_TIMESTAMP - interval '30 days')::int AS accepted_last_30_days
        FROM quotes
      `,
    ),
    query(
      `
        SELECT COUNT(*) FILTER (WHERE p.closed_at IS NULL)::int AS open,
               COUNT(*) FILTER (WHERE s.kind = 'NEW')::int AS not_started,
               COUNT(*) FILTER (WHERE s.kind = 'OPEN')::int AS in_progress
        FROM projects p JOIN project_statuses s ON s.id = p.status_id
      `,
    ),
    ContractService.getSummary(),
  ]);

  return {
    actions: { ...actions.mine, team: actions.team ?? null, link: "/actions" },
    messages: {
      unread_messages: notifications.unread_messages,
      unread_notifications: notifications.unread_notifications,
      link: "/messages",
    },
    work_orders: { ...workOrders.rows[0], link: "/work-orders" },
    inquiries: { ...inquiries.rows[0], link: "/inquiries" },
    quotes: { ...quotes.rows[0], link: "/quotes" },
    projects: { ...projects.rows[0], link: "/projects" },
    subscriptions: {
      available: true,
      active: subscriptions.active,
      paused: subscriptions.paused,
      billing_within_7_days: subscriptions.billing_within_7_days,
      failed_direct_debits_open: subscriptions.failed_direct_debits_open,
      link: "/subscriptions",
    },
  };
};

// New website (and other) inquiries stay at the top until someone opens them (FR-DASH-02):
// they are the unread NEW_INQUIRY notifications of this user
const getHighlightedInquiries = async (userId: string) => {
  // New inquiries that nobody has opened yet: `first_opened_at` is set the first time anyone opens one
  // (GET /inquiries/:id), so it disappears for everyone as soon as one colleague has looked at it
  const result = await query(
    `
      SELECT i.id AS inquiry_id, i.reference, i.source::text AS source, i.contact_name, s.key AS status_key,
             i.created_at AS "createdAt",
             'New inquiry ' || i.reference || ' from ' || COALESCE(r.name, i.contact_name) AS title,
             i.description AS body,
             n.id AS notification_id
      FROM inquiries i
      JOIN inquiry_statuses s ON s.id = i.status_id
      LEFT JOIN relations r ON r.id = i.relation_id
      LEFT JOIN notifications n ON n.entity_id = i.id AND n.entity_type = 'inquiry' AND n.type = 'NEW_INQUIRY'
                               AND n.user_id = $1::uuid AND n.read_at IS NULL
      WHERE i.first_opened_at IS NULL
      ORDER BY i.created_at DESC LIMIT 10
    `,
    [userId],
  );
  const count = await query(
    `SELECT COUNT(*)::int AS n FROM inquiries WHERE first_opened_at IS NULL`,
  );
  return { total: count.rows[0].n, items: result.rows };
};

// What the Beheerder watches: the value still to be earned and the money still to come in (FR-DASH-03).
// Kantoor does not get revenue totals (permission matrix: "no revenue totals if restricted").
const getFinancials = async () => {
  const [projects, invoices] = await Promise.all([
    query(
      `
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(budget_excl_vat + additional_excl_vat), 0)::float8 AS value_excl_vat
        FROM projects WHERE closed_at IS NULL
      `,
    ),
    query(
      `
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(open_amount), 0)::float8 AS outstanding_incl_vat,
               COUNT(*) FILTER (WHERE due_date < ${todaySql})::int AS overdue_count,
               COALESCE(SUM(open_amount) FILTER (WHERE due_date < ${todaySql}), 0)::float8 AS overdue_incl_vat
        FROM (
          SELECT due_date, (total_incl_vat - credited_amount - paid_amount) AS open_amount
          FROM invoices
          WHERE status = 'ISSUED' AND kind <> 'CREDIT_NOTE' AND payment_status IN ('OPEN', 'PARTIALLY_PAID')
        ) i WHERE open_amount > 0
      `,
    ),
  ]);
  return {
    open_projects: {
      count: projects.rows[0].count,
      value_excl_vat: r2(projects.rows[0].value_excl_vat),
      link: "/projects?open=true",
    },
    open_invoices: {
      count: invoices.rows[0].count,
      outstanding_incl_vat: r2(invoices.rows[0].outstanding_incl_vat),
      overdue_count: invoices.rows[0].overdue_count,
      overdue_incl_vat: r2(invoices.rows[0].overdue_incl_vat),
      link: "/invoices?payment_status=OPEN,PARTIALLY_PAID",
    },
  };
};

// Things that need attention. SnelStart sync errors (FR-DASH-06) and failed direct debits create
// automatic tasks; the warning counts the ones still open.
const getWarnings = async (actor: IDashActor) => {
  const result = await query(
    `SELECT auto_type, COUNT(*)::int AS n FROM actions
     WHERE status = 'OPEN' AND auto_type IN ('snelstart_sync_error', 'direct_debit_failed') GROUP BY auto_type`,
  );
  const count = (type: string) =>
    result.rows.find((r: any) => r.auto_type === type)?.n ?? 0;
  const warnings: {
    type: string;
    severity: string;
    count: number;
    message: string;
    link: string;
  }[] = [];

  if (isAdmin(actor) && count("snelstart_sync_error") > 0) {
    warnings.push({
      type: "SNELSTART_SYNC_ERRORS",
      severity: "ERROR",
      count: count("snelstart_sync_error"),
      message: `${count("snelstart_sync_error")} SnelStart synchronisation error(s) are waiting to be resolved`,
      link: "/actions?auto_type=snelstart_sync_error&status=OPEN",
    });
  }
  if (count("direct_debit_failed") > 0) {
    warnings.push({
      type: "DIRECT_DEBIT_FAILED",
      severity: "WARNING",
      count: count("direct_debit_failed"),
      message: `${count("direct_debit_failed")} failed direct debit(s) need follow-up`,
      link: "/actions?auto_type=direct_debit_failed&status=OPEN",
    });
  }
  return warnings;
};

const getRecentEvents = async (params: Record<string, any>) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );
  const conditions: string[] = [];
  const values: any[] = [];
  let n = 1;

  if (params.types) {
    const types = String(
      Array.isArray(params.types) ? params.types.join(",") : params.types,
    )
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    if (types.length === 0 || types.some((t) => !/^[A-Z_]{3,50}$/.test(t))) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Types should be event names like QUOTE_ACCEPTED, separated by commas!",
      );
    }
    conditions.push(`t.event_type = ANY($${n++}::text[])`);
    values.push(types);
  } else if (String(params.scope ?? "key").toLowerCase() !== "all") {
    conditions.push(`t.event_type = ANY($${n++}::text[])`);
    values.push(keyEvents.map((e) => e.type));
  }
  for (const [param, operator] of [
    ["from", ">="],
    ["to", "<"],
  ] as const) {
    if (params[param]) {
      const day = String(params[param]);
      if (!isValidDay(day)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${param} must be a date like 2026-11-30!`,
        );
      }
      // a whole Amsterdam day: from the start of `from`, up to (not including) the day after `to`
      const bound = param === "to" ? addDays(day, 1) : day;
      conditions.push(
        `t.created_at ${operator} ($${n++}::date::timestamp AT TIME ZONE 'Europe/Amsterdam')`,
      );
      values.push(bound);
    }
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [rows, count] = await Promise.all([
    query(
      `
        SELECT t.id, t.event_type, t.title, t.description, t.created_at AS "createdAt",
               json_build_object('id', r.id, 'name', r.name) AS relation,
               CASE WHEN t.actor_id IS NULL THEN NULL ELSE json_build_object('id', u.id, 'name', u.name) END AS actor,
               CASE WHEN t.entity_type IS NULL THEN NULL ELSE json_build_object('type', t.entity_type, 'id', t.entity_id, 'label', ${recordLabelSql("t.entity_type", "t.entity_id")}) END AS entity
        FROM relation_timeline t
        JOIN relations r ON r.id = t.relation_id
        LEFT JOIN users u ON u.id = t.actor_id
        ${where}
        ORDER BY t.created_at DESC, t.id DESC LIMIT $${n} OFFSET $${n + 1}
      `,
      [...values, limit, skip],
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM relation_timeline t ${where}`,
      values,
    ),
  ]);

  const total = count.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: rows.rows.map((e: any) => ({
      ...e,
      category: categoryOf(e.event_type),
    })),
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
// Overview numbers, the latest projects and the performance graph (office dashboard)
// ---------------------------------------------------------------------------

// Totals over everything: projects, inquiries, finished projects (status of kind CLOSED) and contacts
const getOverview = async () => {
  const result = await query(
    `SELECT (SELECT COUNT(*) FROM projects)::int AS total_projects,
            (SELECT COUNT(*) FROM projects p JOIN project_statuses ps ON ps.id = p.status_id WHERE ps.kind = 'CLOSED')::int AS completed_projects,
            (SELECT COUNT(*) FROM projects p JOIN project_statuses ps ON ps.id = p.status_id WHERE ps.kind <> 'CLOSED')::int AS open_projects,
            (SELECT COUNT(*) FROM inquiries)::int AS total_inquiries,
            (SELECT COUNT(*) FROM relation_contacts)::int AS total_contacts,
            (SELECT COUNT(*) FROM relations WHERE is_active)::int AS total_relations`,
  );
  // total_contacts = contact persons; total_relations = the active customers / suppliers they belong to
  return result.rows[0];
};

// The five most recently created projects
const getRecentProjects = async (limit = 5) => {
  const result = await query(
    `SELECT p.id, p.number, p.title, p.created_at AS "createdAt",
            json_build_object('id', r.id, 'name', r.name) AS relation,
            json_build_object('key', ps.key, 'label_nl', ps.label_nl, 'label_en', ps.label_en, 'kind', ps.kind) AS status
     FROM projects p
     JOIN relations r ON r.id = p.relation_id
     JOIN project_statuses ps ON ps.id = p.status_id
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((row: any) => ({
    ...row,
    link: `/projects/${row.id}`,
  }));
};

const maxPerformanceMonths = 36;

// Month by month: projects started and completed, inquiries received (and, for the Beheerder only, what was
// invoiced). Default = the last six months including this one; `from` / `to` (whole Amsterdam days,
// like 2026-06-01) choose another period. A month at the edge only counts the days inside the period.
const getPerformance = async (
  params: Record<string, any>,
  actor: IDashActor,
) => {
  const today = amsterdamToday();
  const firstOfMonth = (day: string) => `${day.slice(0, 7)}-01`;
  const monthsBack = (day: string, n: number) => {
    const [y, m] = day.slice(0, 7).split("-").map(Number);
    const index = y * 12 + (m - 1) - n;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
  };

  for (const key of ["from", "to"]) {
    if (
      params[key] !== undefined &&
      (typeof params[key] !== "string" || !isValidDay(params[key]))
    ) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${key} must be a date like 2026-11-30!`,
      );
    }
  }
  const to: string = params.to ?? today;
  const from: string = params.from ?? monthsBack(to, 5);
  if (from > to)
    throw new ApiError(httpStatus.BAD_REQUEST, "from cannot be after to!");
  const months =
    Number(to.slice(0, 4)) * 12 +
    Number(to.slice(5, 7)) -
    (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7))) +
    1;
  if (months > maxPerformanceMonths) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `The period can cover at most ${maxPerformanceMonths} months!`,
    );
  }

  const amsterdam = (col: string) =>
    `(${col} AT TIME ZONE 'Europe/Amsterdam')::date`;
  const result = await query(
    `
      WITH months AS (
        SELECT generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month')::date AS m
      ), bounds AS (
        SELECT m, GREATEST(m, $1::date) AS d_from,
               LEAST((m + interval '1 month' - interval '1 day')::date, $2::date) AS d_to
        FROM months
      )
      SELECT to_char(b.m, 'YYYY-MM') AS month,
             (SELECT COUNT(*)::int FROM projects p WHERE ${amsterdam("p.created_at")} BETWEEN b.d_from AND b.d_to) AS projects_started,
             (SELECT COUNT(*)::int FROM projects p WHERE p.closed_at IS NOT NULL AND ${amsterdam("p.closed_at")} BETWEEN b.d_from AND b.d_to) AS projects_completed,
             (SELECT COUNT(*)::int FROM inquiries i WHERE ${amsterdam("i.created_at")} BETWEEN b.d_from AND b.d_to) AS inquiries_received,
             (SELECT COALESCE(SUM(v.total_excl_vat), 0)::float8 FROM invoices v
               WHERE v.status = 'ISSUED' AND v.invoice_date BETWEEN b.d_from AND b.d_to) AS invoiced_excl_vat
      FROM bounds b
      ORDER BY b.m ASC
    `,
    [from, to],
  );

  const money = isAdmin(actor);
  const data = result.rows.map((row: any) => ({
    month: row.month,
    projects_started: row.projects_started,
    projects_completed: row.projects_completed,
    inquiries_received: row.inquiries_received,
    // The money is for the Beheerder only (the same rule as the financials block)
    ...(money ? { invoiced_excl_vat: r2(row.invoiced_excl_vat) } : {}),
  }));
  const sum = (key: string) =>
    data.reduce((n: number, row: any) => n + (row[key] ?? 0), 0);
  return {
    from,
    to,
    data,
    totals: {
      projects_started: sum("projects_started"),
      projects_completed: sum("projects_completed"),
      inquiries_received: sum("inquiries_received"),
      ...(money ? { invoiced_excl_vat: r2(sum("invoiced_excl_vat")) } : {}),
    },
  };
};

const getOfficeDashboard = async (
  actor: IDashActor,
  params: Record<string, any> = {},
) => {
  const [
    // tiles,
    highlighted,
    // warnings,
    events,
    financials,
    overview,
    recentProjects,
    performance,
  ] = await Promise.all([
    // getTiles(actor),
    getHighlightedInquiries(actor.id),
    // getWarnings(actor),
    getRecentEvents({ limit: 5 }),
    isAdmin(actor) ? getFinancials() : Promise.resolve(null),
    getOverview(),
    getRecentProjects(5),
    getPerformance(params, actor),
  ]);
  return {
    view:
      actor.role === "SUPERADMIN" || actor.role === "ADMIN"
        ? "ADMIN"
        : ("OFFICE" as const),
    generated_at: new Date().toISOString(),
    highlighted_inquiries: highlighted,
    // warnings,
    // tiles,
    overview,
    recent_projects: recentProjects,
    performance,
    financials,
    recent_events: events.data,
  };
};

// ---------------------------------------------------------------------------
// The field crew dashboard (FR-DASH-05): today's appointments and open work orders, no money
// ---------------------------------------------------------------------------

const getFieldDashboard = async (actor: IDashActor) => {
  const today = amsterdamToday();
  const [appointments, workOrders, actions, notifications] = await Promise.all([
    PlanningService.getMySchedule(actor.id, { from: today, to: today }),
    WorkOrderService.getMyWorkOrders(actor.id, { limit: 50 }),
    ActionService.getSummary(actor),
    NotificationService.getSummary(actor.id),
  ]);
  return {
    view: "FIELD" as const,
    generated_at: new Date().toISOString(),
    today,
    appointments,
    work_orders: { total: workOrders.meta.total, items: workOrders.data },
    actions: actions.mine,
    // messages: {
    //   unread_messages: notifications.unread_messages,
    //   unread_notifications: notifications.unread_notifications,
    // },
  };
};

// Everyone lands on the right one for their role
const getDashboard = async (
  actor: IDashActor,
  params: Record<string, any> = {},
) =>
  ["SUPERADMIN", "ADMIN", "OFFICE"].includes(actor.role)
    ? getOfficeDashboard(actor, params)
    : getFieldDashboard(actor);

export const DashboardService = { getDashboard, getRecentEvents };
