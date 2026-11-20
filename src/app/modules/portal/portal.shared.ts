import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { query } from "../../utils/db";

// Pieces shared by the portal services. The rule of the whole portal (NFR / acceptance test 11):
// a portal user only ever reaches records that belong to their own relation. Every query in the
// customer portal is filtered by the relation returned here, never by an id from the request alone,
// and a record of someone else answers 404, exactly like one that does not exist.

export const clean = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : (value ?? null);

export const customerTypes = ["PRIVATE", "BUSINESS", "VVE"];

export interface IPortalUser {
  id: string;
  name: string;
  email: string;
  role: string;
  relation_id: string;
  preferred_language: string;
  phone_number: string | null;
}

// The signed-in customer and their relation. A customer account without a relation sees nothing.
export const loadPortalUser = async (userId: string, role: "CUSTOMER" | "SUBCONTRACTOR" = "CUSTOMER"): Promise<IPortalUser> => {
  const result = await query(
    `SELECT id, name, email, role::text AS role, relation_id, preferred_language::text AS preferred_language, phone_number
     FROM users WHERE id = $1::uuid AND role::text = $2`,
    [userId, role],
  );
  const user = result.rows[0];
  if (!user || !user.relation_id) {
    throw new ApiError(httpStatus.FORBIDDEN, role === "CUSTOMER" ? "This account is not linked to a customer!" : "This account is not linked to a subcontractor!");
  }
  return user;
};

export const todaySql = `(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Amsterdam')::date`;
export const round2 = (n: number) => Math.round(n * 100) / 100;
