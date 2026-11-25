import httpStatus from "http-status";
import * as bcrypt from "bcrypt";
import ApiError from "../../errors/ApiError";
import config from "../../../config";
import { query } from "../../utils/db";
import assertUuid from "../../utils/assertUuid";
import { buildUpdate } from "../../utils/sqlBuilders";
import { paginationHelper } from "../../helpers/paginationHelper";
import { invalidateAuthCache } from "../../middlewares/auth";
import { disconnectUser } from "../../lib/realtime";
import { logAudit } from "../../utils/audit";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { TLanguage } from "../../utils/i18n";
import {
  assertEmailAvailable,
  normalizeEmail,
  userColumns,
  userDetailsColumns,
} from "../user/user.utils";
import { IAdminUpdateUser, ICreateUser } from "./admin.interface";

// Columns a Beheerder may change on another user -> optional SQL cast
const adminUpdatableFields: Record<string, string> = {
  name: "",
  phone_number: "",
  address: "",
  role: '::"Role"',
  status: '::"UserStatus"',
  is_active: "",
  preferred_language: '::"Language"',
};

// Get All Users - for the Beheerder's user management screen
const allUsers = async (pagination: any) => {
  const { page, limit, skip, sortBy, sortOrder } =
    paginationHelper.calculatePagination(pagination);

  // Sort column / direction go into the SQL text, so only whitelisted values are allowed
  const sortableColumns = ["created_at", "name", "email", "role", "status"];
  const safeSortBy = sortableColumns.includes(sortBy) ? sortBy : "created_at";
  const safeSortOrder = sortOrder.toLowerCase() === "asc" ? "ASC" : "DESC";

  // Super admin accounts are never listed
  const conditions: string[] = [`role != 'SUPERADMIN'::"Role"`];
  const values: any[] = [];
  let paramCount = 1;

  if (pagination.searchTerm) {
    conditions.push(
      `(name ILIKE $${paramCount} OR email ILIKE $${paramCount} OR phone_number ILIKE $${paramCount})`,
    );
    values.push(`%${String(pagination.searchTerm).trim()}%`);
    paramCount++;
  }

  if (pagination.role) {
    conditions.push(`role = $${paramCount++}::"Role"`);
    values.push(pagination.role);
  }

  if (pagination.status) {
    conditions.push(`status = $${paramCount++}::"UserStatus"`);
    values.push(pagination.status);
  }

  if (pagination.is_active !== undefined) {
    conditions.push(`is_active = $${paramCount++}`);
    values.push(String(pagination.is_active) === "true");
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const usersResult = await query(
    `
        SELECT ${userColumns}
        FROM users
        ${whereClause}
        ORDER BY ${safeSortBy} ${safeSortOrder}
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `,
    [...values, limit, skip],
  );

  const countResult = await query(
    `SELECT COUNT(*) as total FROM users ${whereClause}`,
    values,
  );

  const totalUsers = parseInt(countResult.rows[0].total);
  const totalPage = Math.ceil(totalUsers / limit);

  return {
    meta: {
      page,
      limit,
      total: totalUsers,
      totalPage,
      hasNextPage: page < totalPage,
      hasPrevPage: page > 1,
    },
    data: usersResult.rows,
  };
};

// Two focused lists for the Beheerder: the customers' portal accounts, and the employees.
// Only the main facts are returned; GET /admin/users/:id has everything. SUPERADMIN is never listed.
const staffRoles = ["ADMIN", "OFFICE", "FIELD"];
const userStatuses = [
  "PENDING",
  "ACTIVE",
  "INACTIVE",
  "BLOCKED",
  "AVAILABLE",
  "UNAVAILABLE",
];

const listUsersByRole = async (
  params: Record<string, any>,
  roles: string[],
  kind: "customers" | "staff",
) => {
  const { page, limit, skip, sortBy, sortOrder } =
    paginationHelper.calculatePagination(params);

  // Sort column / direction go into the SQL text, so only whitelisted values are allowed
  const sortable: Record<string, string> = {
    created_at: "u.created_at",
    name: "LOWER(u.name)",
    email: "LOWER(u.email)",
    status: "u.status::text",
    ...(kind === "staff"
      ? { role: "u.role::text" }
      : { last_login_at: "u.last_login_at" }),
  };
  const orderColumn = sortable[sortBy] ?? "u.created_at";
  const direction = String(sortOrder).toLowerCase() === "asc" ? "ASC" : "DESC";

  const values: any[] = [];
  const push = (v: any) => {
    values.push(v);
    return `$${values.length}`;
  };

  // Staff can be narrowed to some of its roles (?role=OFFICE or ?role=OFFICE,FIELD)
  let wanted = roles;
  if (kind === "staff" && params.role) {
    wanted = String(params.role)
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
    if (wanted.length === 0 || wanted.some((r) => !roles.includes(r))) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `role should be one or more of ${roles.join(", ")}!`,
      );
    }
  }
  const conditions: string[] = [`u.role::text = ANY(${push(wanted)}::text[])`];

  if (params.status) {
    const list = String(params.status)
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
    if (list.length === 0 || list.some((x) => !userStatuses.includes(x))) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `status should be one or more of ${userStatuses.join(", ")}!`,
      );
    }
    conditions.push(`u.status::text = ANY(${push(list)}::text[])`);
  }
  if (params.is_active !== undefined) {
    conditions.push(
      `u.is_active = ${push(String(params.is_active) === "true")}`,
    );
  }
  if (kind === "customers" && params.relation_id) {
    assertUuid(String(params.relation_id), "relation id");
    conditions.push(`u.relation_id = ${push(params.relation_id)}::uuid`);
  }
  if (params.searchTerm) {
    const p = push(
      `%${String(
        Array.isArray(params.searchTerm)
          ? params.searchTerm[0]
          : params.searchTerm,
      )
        .trim()
        .replace(/[%_\\]/g, "\\$&")}%`,
    );
    conditions.push(
      kind === "customers"
        ? `(u.name ILIKE ${p} OR u.email ILIKE ${p} OR u.phone_number ILIKE ${p} OR r.name ILIKE ${p})`
        : `(u.name ILIKE ${p} OR u.email ILIKE ${p} OR u.phone_number ILIKE ${p})`,
    );
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const columns =
    kind === "customers"
      ? `u.id, u.name, u.email, u.phone_number, u.avatar, u.status, u.is_active, u.last_login_at,
         CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object('id', r.id, 'name', r.name, 'type', r.type) END AS relation,
         u.created_at AS "createdAt"`
      : `u.id, u.name, u.email, u.phone_number, u.avatar, u.role, u.status, u.is_active,
         u.created_at AS "createdAt"`;
  const join =
    kind === "customers" ? "LEFT JOIN relations r ON r.id = u.relation_id" : "";

  const [rows, count] = await Promise.all([
    query(
      `SELECT ${columns} FROM users u ${join} ${where}
       ORDER BY ${orderColumn} ${direction} NULLS LAST, u.id ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, skip],
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM users u ${join} ${where}`,
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

// Customers' portal accounts (role CUSTOMER), each with the relation it belongs to
const allCustomers = (params: Record<string, any>) =>
  listUsersByRole(params, ["CUSTOMER"], "customers");

// Employees: admin, office and field crew
const allStaff = (params: Record<string, any>) =>
  listUsersByRole(params, staffRoles, "staff");

// Get one user by id (Beheerder)
const getUserById = async (id: string) => {
  assertUuid(id, "user id");

  const result = await query(
    `SELECT ${userDetailsColumns} FROM users
     WHERE id = $1::uuid AND role != 'SUPERADMIN'::"Role"`,
    [id],
  );

  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found!");
  }

  return result.rows[0];
};

// Create an internal user (Beheerder only; there is no public self-registration)
const createUser = async (payload: ICreateUser, actorId?: string) => {
  const email = normalizeEmail(payload.email);
  await assertEmailAvailable(email);

  const hashedPassword = await bcrypt.hash(
    payload.password,
    Number(config.bcrypt_salt_rounds) || 12,
  );

  const result = await query(
    `
        INSERT INTO users (
            name, email, password, phone_number, role, status,
            is_email_verified, is_verified, is_active, preferred_language
        ) VALUES (
            $1, $2, $3, $4, $5::"Role", 'ACTIVE'::"UserStatus",
            true, true, true, $6::"Language"
        )
        RETURNING ${userColumns}
    `,
    [
      payload.name.trim(),
      email,
      hashedPassword,
      payload.phone_number ?? null,
      payload.role,
      payload.preferred_language ?? "NL",
    ],
  );

  const created = result.rows[0];

  // Email the login details to the new user. A failing email never undoes the creation:
  // the response says whether it was sent.
  let emailSent = true;
  try {
    await sendTemplatedEmail({
      to: email,
      templateKey: "account_created",
      language: (payload.preferred_language ?? "NL") as TLanguage,
      variables: {
        name: payload.name.trim(),
        email,
        password: payload.password,
        link: `${config.frontend_url}/login`,
      },
      related: { type: "user", id: created.id },
      sentBy: actorId ?? null,
    });
  } catch (error: any) {
    emailSent = false;
    console.error("❌ Could not send the account email:", error?.message);
  }

  return { ...created, welcome_email: { sent: emailSent } };
};

// Update another user: edit, deactivate, re-assign role (Beheerder only)
const updateUserByAdmin = async (
  actor: { id: string; role: string },
  targetId: string,
  payload: IAdminUpdateUser,
) => {
  assertUuid(targetId, "user id");

  const targetResult = await query(
    `SELECT id, role FROM users WHERE id = $1::uuid`,
    [targetId],
  );

  if (targetResult.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found!");
  }

  const target = targetResult.rows[0];

  // Only a super admin may touch another super admin
  if (target.role === "SUPERADMIN" && actor.role !== "SUPERADMIN") {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      "You are not allowed to modify a super admin!",
    );
  }

  // Prevent an admin from locking themselves out
  if (
    actor.id === targetId &&
    (payload.role !== undefined ||
      payload.status !== undefined ||
      payload.is_active !== undefined)
  ) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "You cannot change your own role or account status!",
    );
  }

  const { updates, values, paramCount } = buildUpdate(
    payload,
    adminUpdatableFields,
  );

  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(targetId);

  const result = await query(
    `
        UPDATE users
        SET ${updates.join(", ")}
        WHERE id = $${paramCount}::uuid
        RETURNING ${userColumns}
    `,
    values,
  );

  // Role / status changes must apply immediately, not after the auth cache TTL
  invalidateAuthCache(targetId);
  // ...and a deactivated, blocked or no-longer-employee account loses its live connection
  const access = (
    await query(
      `SELECT role::text AS role, status::text AS status, is_active FROM users WHERE id = $1::uuid`,
      [targetId],
    )
  ).rows[0];
  if (
    access &&
    (!access.is_active ||
      access.status !== "ACTIVE" ||
      !["SUPERADMIN", "ADMIN", "OFFICE", "FIELD"].includes(access.role))
  ) {
    disconnectUser(targetId);
  }

  return result.rows[0];
};

// Clear a user's two-factor setup (lost phone and recovery codes). At their next
// login they must set it up again. Only a super admin may reset a super admin.
const resetTwoFactor = async (
  actor: { id: string; role: string },
  targetId: string,
) => {
  assertUuid(targetId, "user id");

  const targetResult = await query(
    `SELECT id, role FROM users WHERE id = $1::uuid`,
    [targetId],
  );

  if (targetResult.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found!");
  }

  if (
    targetResult.rows[0].role === "SUPERADMIN" &&
    actor.role !== "SUPERADMIN"
  ) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      "You are not allowed to modify a super admin!",
    );
  }

  await query(
    `
        UPDATE users
        SET two_factor_enabled = false, two_factor_secret = NULL,
            two_factor_recovery_codes = '{}', two_factor_last_step = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid
    `,
    [targetId],
  );
  invalidateAuthCache(targetId);

  await logAudit({
    actor_id: actor.id,
    action: "UPDATE",
    entity_type: "user",
    entity_id: targetId,
    changes: { two_factor: { to: "reset" } },
  });

  return { message: "Two-factor authentication has been reset" };
};

export const AdminService = {
  resetTwoFactor,
  allUsers,
  allCustomers,
  allStaff,
  getUserById,
  createUser,
  updateUserByAdmin,
};
