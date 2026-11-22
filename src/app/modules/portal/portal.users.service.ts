import crypto from "crypto";
import httpStatus from "http-status";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { invalidateAuthCache } from "../../middlewares/auth";
import assertUuid from "../../utils/assertUuid";
import { query, transaction } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { toLanguage } from "../../utils/i18n";
import { RelationService } from "../relation/relation.service";
import { clean, customerTypes } from "./portal.shared";

// The office side of the customer portal: inviting a customer contact to the portal from the
// relation (FR-PORT-01), several portal users per relation (FR-PORT-02), and deactivating a portal
// user and seeing when they last signed in (FR-PORT-11). A portal user is a user with role CUSTOMER
// that belongs to one relation. The invitation is a link to set a password: it is the same kind of
// single-use, hashed token as a password reset, but valid longer.

const INVITATION_DAYS = 7;
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const columns = `
  u.id, u.name, u.email, u.phone_number, u.preferred_language::text AS preferred_language, u.is_active,
  (u.password IS NOT NULL) AS has_password, u.last_login_at, u.portal_invited_at, u.created_at AS "createdAt",
  CASE WHEN NOT u.is_active THEN 'DEACTIVATED' WHEN u.password IS NULL THEN 'INVITED' ELSE 'ACTIVE' END AS state,
  json_build_object('id', r.id, 'name', r.name, 'type', r.type) AS relation
`;

// One service per kind of portal user: the same steps for customers and for subcontractors
const createUserService = (kind: "CUSTOMER" | "SUBCONTRACTOR") => {
const role = kind;
const allowedTypes = kind === "CUSTOMER" ? customerTypes : ["SUBCONTRACTOR"];
const templateKey = kind === "CUSTOMER" ? "portal_invitation" : "subcontractor_invitation";
const label = kind === "CUSTOMER" ? "customer" : "subcontractor";

const readUser = async (id: string) => {
  const result = await query(
    `SELECT ${columns} FROM users u JOIN relations r ON r.id = u.relation_id WHERE u.id = $1::uuid AND u.role::text = '${role}'`,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Portal user not found!");
  }
  return result.rows[0];
};

// A fresh link replaces any older ones. Returns whether the email went out.
const sendInvitation = async (user: { id: string; name: string; email: string; preferred_language: string }) => {
  const token = crypto.randomBytes(32).toString("hex");
  await transaction(async (client) => {
    await client.query(`DELETE FROM password_reset_tokens WHERE user_id = $1::uuid`, [user.id]);
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1::uuid, $2, CURRENT_TIMESTAMP + ($3 || ' days')::interval)`,
      [user.id, hashToken(token), String(INVITATION_DAYS)],
    );
    await client.query(`UPDATE users SET portal_invited_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [user.id]);
  });

  try {
    await sendTemplatedEmail({
      to: user.email,
      templateKey,
      language: toLanguage(user.preferred_language),
      variables: { name: user.name, link: `${config.frontend_url}/portal/set-password?token=${token}` },
      related: { type: "user", id: user.id },
    });
    return true;
  } catch {
    // already logged by the email service; the office can send it again
    return false;
  }
};

const inviteUser = async (
  input: { relation_id: string; contact_id?: string; name?: string; email?: string; phone_number?: string; language?: "NL" | "EN" },
  actorId: string,
) => {
  assertUuid(input.relation_id, "relation id");
  const relation = await query(`SELECT id, name, type::text AS type, is_active, preferred_language::text AS preferred_language FROM relations WHERE id = $1::uuid`, [input.relation_id]);
  if (relation.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Relation not found!");
  }
  const rel = relation.rows[0];
  if (!allowedTypes.includes(rel.type)) {
    throw new ApiError(httpStatus.BAD_REQUEST, kind === "CUSTOMER" ? "Only customers (private, business or VvE) can have portal users!" : "Only subcontractors can have subcontractor portal users!");
  }
  if (!rel.is_active) {
    throw new ApiError(httpStatus.BAD_REQUEST, "This customer is deactivated!");
  }

  let name = clean(input.name);
  let email = clean(input.email)?.toLowerCase() ?? null;
  let phoneNumber = clean(input.phone_number);
  if (input.contact_id) {
    assertUuid(input.contact_id, "contact id");
    const contact = await query(`SELECT name, email, phone FROM relation_contacts WHERE id = $1::uuid AND relation_id = $2::uuid`, [input.contact_id, rel.id]);
    if (contact.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Contact not found on this customer!");
    }
    name = name ?? contact.rows[0].name;
    email = email ?? contact.rows[0].email?.toLowerCase() ?? null;
    phoneNumber = phoneNumber ?? contact.rows[0].phone ?? null;
  }
  if (!name || !email) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The contact needs a name and an email address to be invited!");
  }

  const taken = await query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
  if (taken.rows.length > 0) {
    throw new ApiError(httpStatus.CONFLICT, "This email address already has an account!");
  }

  const language = input.language ?? toLanguage(rel.preferred_language);
  const created = await transaction(async (client) => {
    const inserted = await client.query(
      `
        INSERT INTO users (name, email, phone_number, role, status, is_active, preferred_language, relation_id, portal_invited_at)
        VALUES ($1, $2, $3, '${role}'::"Role", 'ACTIVE'::"UserStatus", true, $4::"Language", $5::uuid, CURRENT_TIMESTAMP)
        RETURNING id, name, email, preferred_language::text AS preferred_language
      `,
      [name, email, phoneNumber, language, rel.id],
    );
    await RelationService.logRelationEvent(
      rel.id,
      { event_type: "PORTAL_USER_INVITED", entity_type: "user", entity_id: inserted.rows[0].id, title: `${name} invited to the ${label} portal`, actor_id: actorId },
      client,
    );
    return inserted.rows[0];
  }).catch((error: any) => {
    // Two invitations for the same address at the same moment
    if (error?.code === "23505") throw new ApiError(httpStatus.CONFLICT, "This email address already has an account!");
    throw error;
  });

  const sent = await sendInvitation(created);
  return { ...(await readUser(created.id)), invitation: { sent } };
};

const getUsers = async (params: Record<string, any>) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const conditions = [`u.role::text = '${role}'`];
  const values: any[] = [];
  let n = 1;

  if (params.relation_id) {
    assertUuid(String(params.relation_id), "relation id");
    conditions.push(`u.relation_id = $${n++}::uuid`);
    values.push(String(params.relation_id));
  }
  if (params.state) {
    const state = String(params.state).toUpperCase();
    if (!["INVITED", "ACTIVE", "DEACTIVATED"].includes(state)) {
      throw new ApiError(httpStatus.BAD_REQUEST, "State should be INVITED, ACTIVE or DEACTIVATED!");
    }
    conditions.push(
      state === "DEACTIVATED" ? `NOT u.is_active` : state === "INVITED" ? `u.is_active AND u.password IS NULL` : `u.is_active AND u.password IS NOT NULL`,
    );
  }
  if (params.searchTerm) {
    const term = String(Array.isArray(params.searchTerm) ? params.searchTerm[0] : params.searchTerm)
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(`(u.name ILIKE $${n} OR u.email ILIKE $${n} OR r.name ILIKE $${n})`);
    values.push(`%${term}%`);
    n++;
  }
  const where = conditions.join(" AND ");

  const [rows, count] = await Promise.all([
    query(`SELECT ${columns} FROM users u JOIN relations r ON r.id = u.relation_id WHERE ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT $${n} OFFSET $${n + 1}`, [...values, limit, skip]),
    query(`SELECT COUNT(*)::int AS total FROM users u JOIN relations r ON r.id = u.relation_id WHERE ${where}`, values),
  ]);
  const total = count.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return { data: rows.rows, meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 } };
};

const getUserById = async (id: string) => {
  assertUuid(id, "user id");
  return readUser(id);
};

// For someone who has not set a password yet. Others use "forgot password".
const resendInvitation = async (id: string, actorId: string) => {
  assertUuid(id, "user id");
  const user = await readUser(id);
  const raw = await query(`SELECT id, name, email, preferred_language::text AS preferred_language FROM users WHERE id = $1::uuid`, [id]);
  if (user.has_password) {
    throw new ApiError(httpStatus.CONFLICT, "This person has already set a password. They can use 'forgot password' if they cannot sign in!");
  }
  if (!user.is_active) {
    throw new ApiError(httpStatus.CONFLICT, "This portal user is deactivated. Reactivate them first!");
  }
  const recent = await query(`SELECT 1 FROM password_reset_tokens WHERE user_id = $1::uuid AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 minute'`, [id]);
  if (recent.rows.length > 0) {
    throw new ApiError(httpStatus.CONFLICT, "An invitation was sent a moment ago. Wait a minute before sending another!");
  }
  const sent = await sendInvitation(raw.rows[0]);
  await RelationService.logRelationEvent(user.relation.id, {
    event_type: "PORTAL_USER_INVITED",
    entity_type: "user",
    entity_id: id,
    title: `Portal invitation sent again to ${user.name}`,
    actor_id: actorId,
  });
  return { ...(await readUser(id)), invitation: { sent } };
};

const updateUser = async (
  id: string,
  payload: { is_active?: boolean; name?: string; phone_number?: string | null; language?: "NL" | "EN" },
  actorId: string,
) => {
  assertUuid(id, "user id");
  const user = await readUser(id);

  const updates: string[] = [];
  const values: any[] = [id];
  let n = 2;
  if (payload.is_active !== undefined) {
    updates.push(`is_active = $${n++}`);
    values.push(payload.is_active);
  }
  if (payload.name !== undefined) {
    updates.push(`name = $${n++}`);
    values.push(payload.name.trim());
  }
  if (payload.phone_number !== undefined) {
    updates.push(`phone_number = $${n++}`);
    values.push(clean(payload.phone_number));
  }
  if (payload.language !== undefined) {
    updates.push(`preferred_language = $${n++}::"Language"`);
    values.push(payload.language);
  }
  updates.push("updated_at = CURRENT_TIMESTAMP");
  await query(`UPDATE users SET ${updates.join(", ")} WHERE id = $1::uuid`, values);

  if (payload.is_active !== undefined && payload.is_active !== user.is_active) {
    // Applies at once, not after the auth cache expires; a pending invitation link stops working too
    invalidateAuthCache(id);
    if (!payload.is_active) await query(`DELETE FROM password_reset_tokens WHERE user_id = $1::uuid`, [id]);
    await RelationService.logRelationEvent(user.relation.id, {
      event_type: payload.is_active ? "PORTAL_USER_REACTIVATED" : "PORTAL_USER_DEACTIVATED",
      entity_type: "user",
      entity_id: id,
      title: `${user.name} ${payload.is_active ? "reactivated" : "deactivated"} in the ${label} portal`,
      actor_id: actorId,
    });
  }
  return readUser(id);
};


return { inviteUser, getUsers, getUserById, resendInvitation, updateUser };
};

export const PortalUserService = createUserService("CUSTOMER");
export const SubcontractorUserService = createUserService("SUBCONTRACTOR");
