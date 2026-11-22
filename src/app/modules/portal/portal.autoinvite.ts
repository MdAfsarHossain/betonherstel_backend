import ApiError from "../../errors/ApiError";
import { query } from "../../utils/db";
import { PortalUserService } from "./portal.users.service";
import { customerTypes } from "./portal.shared";

// The customer's first quotation (FR-PORT-01, FR-QUO-08): the quotation is published in the portal, so
// the customer needs an account to see it. When a quotation is sent to a customer who has no portal
// user yet, the person it was sent to is invited with the usual "set your password" link (the same
// single-use link, valid 7 days, as an invitation sent by hand). It is a courtesy: it **never throws**
// and never gets in the way of sending the quotation.

export type TAutoInviteResult =
  | { invited: true; to: string; email_sent: boolean; user_id: string }
  | { invited: false; reason: "OPTED_OUT" | "NO_EMAIL" | "NOT_A_CUSTOMER" | "ALREADY_HAS_PORTAL_USER" | "EMAIL_IN_USE" | "ERROR" };

export const inviteCustomerAfterQuote = async (input: {
  relationId: string;
  name: string | null;
  email: string | null;
  language?: "NL" | "EN";
  actorId: string | null;
  optOut?: boolean;
}): Promise<TAutoInviteResult> => {
  try {
    if (input.optOut) return { invited: false, reason: "OPTED_OUT" };
    const email = input.email?.trim().toLowerCase();
    if (!email) return { invited: false, reason: "NO_EMAIL" };

    const relation = await query(`SELECT name, type::text AS type, is_active FROM relations WHERE id = $1::uuid`, [input.relationId]);
    const rel = relation.rows[0];
    if (!rel || !rel.is_active || !customerTypes.includes(rel.type)) return { invited: false, reason: "NOT_A_CUSTOMER" };

    // Anyone who ever had a portal account (even a deactivated one) means the customer is already handled
    const existing = await query(`SELECT 1 FROM users WHERE relation_id = $1::uuid AND role::text = 'CUSTOMER' LIMIT 1`, [input.relationId]);
    if (existing.rows.length > 0) return { invited: false, reason: "ALREADY_HAS_PORTAL_USER" };

    // An address that already belongs to an account (an employee, another customer) is never taken over
    const taken = await query(`SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [email]);
    if (taken.rows.length > 0) return { invited: false, reason: "EMAIL_IN_USE" };

    const user: any = await PortalUserService.inviteUser(
      { relation_id: input.relationId, name: input.name?.trim() || rel.name, email, language: input.language },
      input.actorId as string,
    );
    return { invited: true, to: email, email_sent: user.invitation?.sent === true, user_id: user.id };
  } catch (error: any) {
    // two quotations sent at the same moment can race for the same address: the second one just finds it taken
    if (error instanceof ApiError && error.statusCode === 409) return { invited: false, reason: "EMAIL_IN_USE" };
    console.error("❌ Could not invite the customer to the portal:", error?.message ?? error);
    return { invited: false, reason: "ERROR" };
  }
};
