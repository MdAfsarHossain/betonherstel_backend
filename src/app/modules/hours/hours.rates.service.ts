import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { amsterdamToday } from "../../utils/dates";
import { query, transaction } from "../../utils/db";
import { toCents } from "../../utils/money";
import { ISetRate } from "./hours.interface";

// Cost rate and sales rate per employee per hour (FR-HRS-04). A rate is valid from a
// date and stays until a later one replaces it, so the history is kept: approving an
// hour copies the rate in force on its work date, and a new rate never rewrites it.

const rateRoles = ["SUPERADMIN", "ADMIN", "OFFICE", "FIELD"];

const rateColumns = `
  r.effective_from::text AS effective_from,
  (r.cost_rate_cents / 100.0)::float8 AS cost_rate,
  (r.sales_rate_cents / 100.0)::float8 AS sales_rate
`;

// Everyone who can log hours, with the rate in force today
const getRates = async () => {
  const today = amsterdamToday();
  const result = await query(
    `
      SELECT u.id, u.name, u.role::text AS role,
             cur.effective_from, cur.cost_rate, cur.sales_rate,
             nxt.effective_from AS next_effective_from,
             (SELECT COUNT(*)::int FROM employee_rates h WHERE h.user_id = u.id) AS history_count
      FROM users u
      LEFT JOIN LATERAL (
        SELECT ${rateColumns} FROM employee_rates r
        WHERE r.user_id = u.id AND r.effective_from <= $1::date
        ORDER BY r.effective_from DESC LIMIT 1
      ) cur ON true
      LEFT JOIN LATERAL (
        SELECT r.effective_from::text AS effective_from FROM employee_rates r
        WHERE r.user_id = u.id AND r.effective_from > $1::date
        ORDER BY r.effective_from ASC LIMIT 1
      ) nxt ON true
      WHERE u.is_active AND u.status = 'ACTIVE' AND u.role::text = ANY($2::text[])
      ORDER BY LOWER(u.name) ASC
    `,
    [today, rateRoles],
  );

  return result.rows.map((r: any) => ({
    user: { id: r.id, name: r.name, role: r.role },
    rate_set: r.cost_rate !== null,
    cost_rate: r.cost_rate,
    sales_rate: r.sales_rate,
    effective_from: r.effective_from,
    next_effective_from: r.next_effective_from,
    history_count: r.history_count,
  }));
};

const assertEmployee = async (userId: string) => {
  assertUuid(userId, "user id");
  const found = await query(`SELECT id, name, role::text AS role FROM users WHERE id = $1::uuid`, [userId]);
  if (found.rows.length === 0 || !rateRoles.includes(found.rows[0].role)) {
    throw new ApiError(httpStatus.NOT_FOUND, "Employee not found!");
  }
  return found.rows[0];
};

const getRateHistory = async (userId: string) => {
  const user = await assertEmployee(userId);
  const result = await query(
    `
      SELECT ${rateColumns}, r.created_at AS "createdAt", c.name AS created_by_name
      FROM employee_rates r LEFT JOIN users c ON c.id = r.created_by
      WHERE r.user_id = $1::uuid
      ORDER BY r.effective_from DESC
    `,
    [userId],
  );
  return { user: { id: user.id, name: user.name, role: user.role }, rates: result.rows };
};

// Sets a rate from a date (today by default). The same date again replaces that rate.
const setRate = async (userId: string, input: ISetRate, actorId: string) => {
  await assertEmployee(userId);
  const effectiveFrom = input.effective_from ?? amsterdamToday();

  await transaction(async (client) => {
    await client.query(
      `
        INSERT INTO employee_rates (user_id, effective_from, cost_rate_cents, sales_rate_cents, created_by)
        VALUES ($1::uuid, $2::date, $3, $4, $5::uuid)
        ON CONFLICT (user_id, effective_from)
        DO UPDATE SET cost_rate_cents = EXCLUDED.cost_rate_cents, sales_rate_cents = EXCLUDED.sales_rate_cents,
                      created_by = EXCLUDED.created_by, created_at = CURRENT_TIMESTAMP
      `,
      [userId, effectiveFrom, toCents(input.cost_rate), toCents(input.sales_rate), actorId],
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "employee_rate",
        entity_id: userId,
        changes: { cost_rate: input.cost_rate, sales_rate: input.sales_rate, effective_from: effectiveFrom },
      },
      client,
    );
  });

  return getRateHistory(userId);
};

// The rate in force on a day, picked from a user's rates (newest first)
export const pickRate = (
  rates: { effective_from: string; cost_rate_cents: number; sales_rate_cents: number }[],
  day: string,
) => rates.find((r) => r.effective_from <= day) ?? null;

export const HoursRatesService = { getRates, getRateHistory, setRate };
