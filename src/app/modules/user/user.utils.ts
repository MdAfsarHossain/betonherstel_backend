import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { query } from "../../utils/db";

// Columns returned for a user. Never include `password` or `fcm_token`.
export const userColumns = `
  id,
  name,
  phone_number,
  email,
  avatar,
  role,
  status,
  two_factor_enabled,
  preferred_language,
  created_at as created_at
  `;
// address,
// date_of_birth,
// is_active,
// is_email_verified,
// is_verified,
// preferred_language,
// updated_at as updated_at;

export const userDetailsColumns = `
  id,
  name,
  phone_number,
  email,
  avatar,
  role,
  status,
  address,
  date_of_birth,
  is_active,
  is_email_verified,
  is_verified,
  preferred_language,
  created_at as created_at,
  updated_at as updated_at
  `;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const assertEmailAvailable = async (
  email: string,
  exceptUserId?: string,
) => {
  const result = await query(
    `
        SELECT id FROM users
        WHERE LOWER(email) = $1
            AND ($2::uuid IS NULL OR id != $2::uuid)
        LIMIT 1
    `,
    [email, exceptUserId ?? null],
  );

  if (result.rows.length > 0) {
    throw new ApiError(httpStatus.CONFLICT, "Email already registered!");
  }
};
