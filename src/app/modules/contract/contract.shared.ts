import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import assertUuid from "../../utils/assertUuid";
import { addDays } from "../../utils/dates";
import { query } from "../../utils/db";
import { RelationService } from "../relation/relation.service";
import { TBillingInterval } from "./contract.interface";
import { TRelationEventType } from "../relation/relation.interface";

// Pieces shared by the contract services: calendar maths on billing dates, and a loader.

export const clean = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : (value ?? null);

export const intervalMonths: Record<TBillingInterval, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };

// Dates are "YYYY-MM-DD" strings, never JavaScript Dates, so they do not shift with the server's timezone.
// Moving by months keeps the contract's own day of the month ("anchor"): 31 January -> 28 February
// -> 31 March, not 28 March.
export const addMonthsAnchored = (day: string, months: number, anchor: number) => {
  const [y, m] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(anchor, daysInMonth)).padStart(2, "0")}`;
};

export const nextBillingDate = (current: string, interval: TBillingInterval, anchor: number) =>
  addMonthsAnchored(current, intervalMonths[interval], anchor);

export const dayOfMonth = (day: string) => Number(day.slice(8, 10));

// The visit dates of a contract that fall in [from, to]: every (12 / visits_per_year) months from the first visit
export const visitDatesBetween = (firstVisit: string, visitsPerYear: number, from: string, to: string) => {
  if (!visitsPerYear) return [] as string[];
  const step = 12 / visitsPerYear;
  const anchor = dayOfMonth(firstVisit);
  const out: string[] = [];
  let date = firstVisit;
  for (let i = 0; i < 1200 && date <= to; i++) {
    if (date >= from) out.push(date);
    date = addMonthsAnchored(firstVisit, step * (i + 1), anchor);
  }
  return out;
};

export const periodLabel = (start: string, end: string) => {
  const f = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
  return `${f(start)} - ${f(end)}`;
};

export const lastDayOfPeriod = (start: string, interval: TBillingInterval, anchor: number) =>
  addDays(nextBillingDate(start, interval, anchor), -1);

export const contractColumns = `
  s.id, s.number, s.relation_id, s.title, s.description,
  s.street, s.house_number, s.postcode, s.city, s.country,
  s.amount_excl_vat::float8 AS amount_excl_vat, s.vat_code, s.billing_interval,
  to_char(s.start_date, 'YYYY-MM-DD') AS start_date, to_char(s.end_date, 'YYYY-MM-DD') AS end_date,
  to_char(s.next_billing_date, 'YYYY-MM-DD') AS next_billing_date, s.anchor_day,
  s.status, s.payment_term_days, s.use_direct_debit, s.language::text AS language,
  s.visits_per_year, to_char(s.first_visit_date, 'YYYY-MM-DD') AS first_visit_date, s.visit_assignee_ids,
  s.internal_notes, s.paused_at, s.ended_at, s.end_reason, s.created_by,
  s.created_at AS "createdAt", s.updated_at AS "updatedAt"
`;

export const loadContract = async (id: string, client?: any) => {
  assertUuid(id, "subscription id");
  const run = client ? client.query.bind(client) : query;
  const result = await run(`SELECT ${contractColumns} FROM subscriptions s WHERE s.id = $1::uuid`, [id]);
  if (result.rows.length === 0) throw new ApiError(httpStatus.NOT_FOUND, "Subscription not found!");
  return result.rows[0];
};

// A contract can be for any customer type (private, business, VvE)
export const loadCustomer = async (relationId: string) => {
  assertUuid(relationId, "relation id");
  const result = await query(
    `SELECT id, type::text AS type, name, email, invoice_email, preferred_language::text AS preferred_language, is_active,
            billing_street, billing_house_number, billing_postcode, billing_city, billing_country
     FROM relations WHERE id = $1::uuid`,
    [relationId],
  );
  if (result.rows.length === 0) throw new ApiError(httpStatus.NOT_FOUND, "Relation not found!");
  const relation = result.rows[0];
  if (!["PRIVATE", "BUSINESS", "VVE"].includes(relation.type)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "A maintenance contract can only be for a customer!");
  }
  if (!relation.is_active) throw new ApiError(httpStatus.BAD_REQUEST, "This relation is deactivated!");
  return relation;
};

export const logContractEvent = (
  contract: { id: string; relation_id: string; number: string },
  eventType: TRelationEventType,
  title: string,
  actorId: string | null,
  metadata: Record<string, any> = {},
  client?: any,
) =>
  RelationService.logRelationEvent(
    contract.relation_id,
    { event_type: eventType, entity_type: "subscription", entity_id: contract.id, title, actor_id: actorId, metadata: { number: contract.number, ...metadata } },
    client,
  );
