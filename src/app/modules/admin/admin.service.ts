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
const createUser = async (payload: ICreateUser) => {
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

  return result.rows[0];
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
  const access = (await query(`SELECT role::text AS role, status::text AS status, is_active FROM users WHERE id = $1::uuid`, [targetId])).rows[0];
  if (access && (!access.is_active || access.status !== "ACTIVE" || !["SUPERADMIN", "ADMIN", "OFFICE", "FIELD"].includes(access.role))) {
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

  if (targetResult.rows[0].role === "SUPERADMIN" && actor.role !== "SUPERADMIN") {
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
  getUserById,
  createUser,
  updateUserByAdmin,
};
