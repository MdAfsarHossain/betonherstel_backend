import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { S3Uploader } from "../../lib/S3Uploader";
import { query } from "../../utils/db";
import { buildUpdate } from "../../utils/sqlBuilders";
import { invalidateAuthCache } from "../../middlewares/auth";
import { IUpdateProfile } from "./user.interface";
import {
  assertEmailAvailable,
  normalizeEmail,
  userColumns,
} from "./user.utils";

// Columns a user may change on their own profile -> optional SQL cast
const selfUpdatableFields: Record<string, string> = {
  name: "",
  phone_number: "",
  email: "",
  address: "",
  date_of_birth: "",
  preferred_language: '::"Language"',
};

// My Profile - the logged-in user's own account
const myProfile = async (userId: string) => {
  const result = await query(
    `SELECT ${userColumns} FROM users WHERE id = $1::uuid`,
    [userId],
  );

  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "This user is not registered.");
  }

  // The old business / KYC profile joins were removed: the `businesses` and
  // `kyc_documents` tables no longer exist, so that query failed on every call.
  // const result = await query(
  //   `
  //       SELECT u.id, ..., json_build_object('id', b.id, ...) as business,
  //              json_build_object('id', k.id, ...) as kyc_document
  //       FROM users u
  //       LEFT JOIN businesses b ON u.id = b.creator_id
  //       LEFT JOIN kyc_documents k ON u.id = k.user_id
  //       WHERE u.id = $1::uuid
  //   `,
  //   [userId],
  // );

  return result.rows[0];
};

// Update the logged-in user's own profile (never role / status / is_active)
const updateUser = async (
  userId: string,
  payload: IUpdateProfile,
  file?: any,
) => {
  const userResult = await query(
    `SELECT id, avatar FROM users WHERE id = $1::uuid`,
    [userId],
  );

  if (userResult.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "This user is not registered.");
  }

  const existingUser = userResult.rows[0];

  const data: Record<string, any> = { ...payload };
  if (data.email !== undefined) {
    data.email = normalizeEmail(data.email);
    await assertEmailAvailable(data.email, userId);
  }

  const { updates, values, paramCount } = buildUpdate(
    data,
    selfUpdatableFields,
  );
  let nextParam = paramCount;

  // Upload new avatar if provided
  if (file) {
    try {
      const fileUrl = await S3Uploader.uploadToS3(
        file,
        `users/avatar/${userId}`,
      );
      updates.push(`avatar = $${nextParam++}`);
      values.push(fileUrl.Location);
    } catch (error) {
      throw new ApiError(
        httpStatus.SERVICE_UNAVAILABLE,
        "Profile image upload failed.",
      );
    }
  }

  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(userId);

  const result = await query(
    `
        UPDATE users
        SET ${updates.join(", ")}
        WHERE id = $${nextParam}::uuid
        RETURNING ${userColumns}
    `,
    values,
  );

  invalidateAuthCache(userId);

  return result.rows[0];
};

export const UserService = {
  myProfile,
  updateUser,
};
