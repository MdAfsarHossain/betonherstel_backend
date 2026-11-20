import * as bcrypt from "bcrypt";
import crypto from "crypto";
import httpStatus from "http-status";
import { Secret } from "jsonwebtoken";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import assertUserActive from "../../helpers/assertUserActive";
import { jwtHelpers } from "../../helpers/jwtHelpers";
import { requiresTwoFactor } from "../../helpers/twoFactorPolicy";
import { transaction, query } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { toLanguage } from "../../utils/i18n";
import {
  buildSession,
  issueSessionTokens,
  issueTwoFactorToken,
} from "./auth.tokens";

// There is no public registration (FR-AUTH-01): internal users are created by a
// Beheerder (POST /admin/users) and portal users are invited by office staff.

const hashToken = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");

// Compared against when the email is unknown, so a wrong email and a wrong
// password take the same time and give the same answer.
const dummyHash = bcrypt.hashSync("not-a-real-password", 10);

// Login User
const loginUserFromDB = async (
  email: string,
  password: string,
  fcm_token?: string,
) => {
  const result: any = await query(
    "SELECT * FROM users WHERE LOWER(email) = LOWER($1)",
    [email.trim()],
  );
  const user = result.rows[0];

  const isCorrectPassword = await bcrypt.compare(
    password,
    user?.password ?? dummyHash,
  );

  if (!user || !user.password || !isCorrectPassword) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid email or password!");
  }

  assertUserActive(user);

  // Second step: a code from the authenticator app
  if (user.two_factor_enabled) {
    return {
      twoFactorRequired: true as const,
      twoFactorToken: issueTwoFactorToken(user, "2fa-login"),
    };
  }

  // Beheerder without 2FA yet: no session until it is set up (FR-AUTH-04)
  if (requiresTwoFactor(user.role)) {
    return {
      twoFactorSetupRequired: true as const,
      setupToken: issueTwoFactorToken(user, "2fa-setup"),
    };
  }

  if (fcm_token) {
    await query(`UPDATE users SET fcm_token = $1 WHERE id = $2::uuid`, [
      fcm_token,
      user.id,
    ]);
  }

  // So the office can see when a portal user last signed in (FR-PORT-11)
  await query(
    `UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
    [user.id],
  );

  return buildSession(user);
};

// Exchange a refresh token for a new pair of tokens. A client that refreshes
// only while the user is active gives an inactivity timeout of
// JWT_ACCESS_EXPIRES_IN (FR-AUTH-05).
const refreshToken = async (token: string) => {
  const payload = jwtHelpers.verifyToken(
    token,
    config.jwt.refresh_secret as Secret,
  );

  const result = await query(`SELECT * FROM users WHERE id = $1::uuid`, [
    payload.id,
  ]);
  const user = result.rows[0];

  if (!user) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "You are not authorized!");
  }

  assertUserActive(user);

  if (requiresTwoFactor(user.role) && !user.two_factor_enabled) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      "Two-factor authentication setup is required for your role!",
    );
  }

  return issueSessionTokens(user);
};

// Forgot Password: emails a time-limited link (FR-AUTH-03). The answer is the
// same whether or not the email is registered, so it cannot be used to find
// out who has an account.
const forgotPassword = async (payload: { email: string }) => {
  const message =
    "If an account exists for this email, a password reset link has been sent.";

  const result = await query(
    `SELECT id, name, email, status, is_active, preferred_language
     FROM users WHERE LOWER(email) = LOWER($1)`,
    [payload.email.trim()],
  );
  const user = result.rows[0];

  if (!user || user.status === "BLOCKED" || !user.is_active) {
    return { message };
  }

  // At most one link per minute per account (stops email flooding)
  const recent = await query(
    `SELECT 1 FROM password_reset_tokens
     WHERE user_id = $1::uuid AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 minute'`,
    [user.id],
  );
  if (recent.rows.length > 0) {
    return { message };
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresMinutes = config.password_reset_expires_minutes;

  // Only the hash is stored; a newer link replaces any older ones
  await transaction(async (client) => {
    await client.query(
      `DELETE FROM password_reset_tokens WHERE user_id = $1::uuid`,
      [user.id],
    );
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1::uuid, $2, CURRENT_TIMESTAMP + ($3 || ' minutes')::interval)`,
      [user.id, hashToken(token), String(expiresMinutes)],
    );
  });

  try {
    await sendTemplatedEmail({
      to: user.email,
      templateKey: "password_reset",
      language: toLanguage(user.preferred_language),
      variables: {
        name: user.name,
        link: `${config.frontend_url}/reset-password?token=${token}`,
        expires_minutes: expiresMinutes,
      },
      related: { type: "user", id: user.id },
    });
  } catch (error) {
    // Already logged by the email service; do not reveal the failure to the caller
  }

  return { message };
};

// Reset Password with the link from the email. The link works once.
const resetPassword = async (token: string, newPassword: string) => {
  const hashedPassword = await bcrypt.hash(
    newPassword,
    Number(config.bcrypt_salt_rounds) || 12,
  );

  await transaction(async (client) => {
    // Marking it used and checking it is one atomic statement
    const used = await client.query(
      `UPDATE password_reset_tokens
       SET used_at = CURRENT_TIMESTAMP
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
       RETURNING user_id`,
      [hashToken(token)],
    );

    if (used.rows.length === 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "This reset link is invalid or has expired!",
      );
    }
    const userId = used.rows[0].user_id;

    await client.query(
      `UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid`,
      [hashedPassword, userId],
    );
    await client.query(
      `DELETE FROM password_reset_tokens WHERE user_id = $1::uuid`,
      [userId],
    );
  });

  return {
    message: "Please login with your new password",
  };
};

// Change Password
const changePassword = async (
  userId: string,
  payload: { oldPassword: string; newPassword: string },
) => {
  const userResult = await query(
    `SELECT id, email, password, status FROM users WHERE id = $1::uuid`,
    [userId],
  );

  if (userResult.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found!");
  }

  const user = userResult.rows[0];

  if (user.status === "BLOCKED") {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      "Your account has been blocked. Please contact support.",
    );
  }

  const isCorrectPassword = await bcrypt.compare(
    payload.oldPassword,
    user.password ?? dummyHash,
  );
  if (!user.password || !isCorrectPassword) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Credentials not matched");
  }

  if (payload.oldPassword === payload.newPassword) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "The new password must be different from the old one!",
    );
  }

  const hashedPassword = await bcrypt.hash(
    payload.newPassword,
    Number(config.bcrypt_salt_rounds) || 12,
  );

  await query(
    `UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid`,
    [hashedPassword, userId],
  );

  return {
    message: "Password updated successfully",
  };
};

export const AuthServices = {
  loginUserFromDB,
  refreshToken,
  forgotPassword,
  resetPassword,
  changePassword,
};
