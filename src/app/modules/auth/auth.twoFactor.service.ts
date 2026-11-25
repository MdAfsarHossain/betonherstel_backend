import * as bcrypt from "bcrypt";
import crypto from "crypto";
import httpStatus from "http-status";
import QRCode from "qrcode";
import ApiError from "../../errors/ApiError";
import assertUserActive from "../../helpers/assertUserActive";
import { requiresTwoFactor } from "../../helpers/twoFactorPolicy";
import { invalidateAuthCache } from "../../middlewares/auth";
import { query } from "../../utils/db";
import { decrypt, encrypt } from "../../utils/encryption";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../../utils/totp";
import { SettingsService } from "../settings/settings.service";
import { buildSession, verifyTwoFactorToken } from "./auth.tokens";

// Two-factor authentication with an authenticator app (FR-AUTH-04).

const hashRecoveryCode = (code: string) =>
  crypto
    .createHash("sha256")
    .update(code.replace(/[\s-]/g, "").toLowerCase())
    .digest("hex");

// 10 single-use codes, shown once, for a lost phone
const generateRecoveryCodes = () =>
  Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(5).toString("hex");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });

const getUser = async (userId: string) => {
  const result = await query(`SELECT * FROM users WHERE id = $1::uuid`, [
    userId,
  ]);
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found!");
  }
  return result.rows[0];
};

// True when the code is valid. A code can be used only once: the matching time
// step is stored, and the same or an older step is rejected afterwards.
const checkCode = async (user: any, code: string) => {
  if (!user.two_factor_secret) return false;

  const step = verifyTotp(decrypt(user.two_factor_secret), code);
  if (step === null) return false;

  const claimed = await query(
    `UPDATE users SET two_factor_last_step = $1
     WHERE id = $2::uuid AND (two_factor_last_step IS NULL OR two_factor_last_step < $1)
     RETURNING id`,
    [step, user.id],
  );
  return claimed.rows.length === 1;
};

// Step 1: create a secret. The user adds it to their authenticator app (the
// frontend can show otpauthUri as a QR code) and confirms with enable().
const setup = async (userId: string) => {
  const user = await getUser(userId);

  if (user.two_factor_enabled) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Two-factor authentication is already enabled!",
    );
  }

  const secret = generateTotpSecret();
  await query(
    `UPDATE users SET two_factor_secret = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid`,
    [encrypt(secret), userId],
  );

  const issuer = (await SettingsService.getCompanySettings()).company_name;
  const uri = otpauthUri(issuer, user.email, secret);
  // A ready-made QR code (PNG as a data URL): show it in an <img src>, scanning it adds the account to the app
  const qrCode = await QRCode.toDataURL(uri, { width: 300, margin: 2 });
  return { secret, otpauthUri: uri, qrCode };
  // return { secret, otpauthUri: uri };
};

// Step 2: prove the app works by entering a code. Turns 2FA on and returns the
// recovery codes (shown only now). If the user came from the login step (setup
// token) they are signed in at the same time.
const enable = async (userId: string, code: string, signIn: boolean) => {
  const user = await getUser(userId);

  if (user.two_factor_enabled) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Two-factor authentication is already enabled!",
    );
  }
  if (!user.two_factor_secret) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Start the two-factor setup first!",
    );
  }
  assertUserActive(user);

  if (!(await checkCode(user, code))) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid authentication code!");
  }

  const recoveryCodes = generateRecoveryCodes();
  await query(
    `UPDATE users
     SET two_factor_enabled = true, two_factor_recovery_codes = $1::text[], updated_at = CURRENT_TIMESTAMP
     WHERE id = $2::uuid`,
    [recoveryCodes.map(hashRecoveryCode), userId],
  );
  invalidateAuthCache(userId);

  return {
    recoveryCodes,
    ...(signIn ? { session: buildSession(user) } : {}),
  };
};

// Second login step: authenticator code or one recovery code
const verifyLogin = async (
  twoFactorToken: string,
  input: { code?: string; recoveryCode?: string },
) => {
  const userId = verifyTwoFactorToken(twoFactorToken, "2fa-login");
  const user = await getUser(userId);
  assertUserActive(user);

  if (!user.two_factor_enabled) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Two-factor authentication is not enabled!",
    );
  }

  let valid = false;
  if (input.code) {
    valid = await checkCode(user, input.code);
  } else if (input.recoveryCode) {
    // Removing the code and checking it is one atomic statement: a code works once
    const used = await query(
      `UPDATE users
       SET two_factor_recovery_codes = array_remove(two_factor_recovery_codes, $1)
       WHERE id = $2::uuid AND $1 = ANY(two_factor_recovery_codes)
       RETURNING id`,
      [hashRecoveryCode(input.recoveryCode), userId],
    );
    valid = used.rows.length === 1;
  }

  if (!valid) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid authentication code!");
  }

  return buildSession(user);
};

// Turn 2FA off again. Not allowed where it is mandatory.
const disable = async (userId: string, password: string, code: string) => {
  const user = await getUser(userId);

  if (requiresTwoFactor(user.role)) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      "Two-factor authentication is mandatory for your role!",
    );
  }
  if (!user.two_factor_enabled) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Two-factor authentication is not enabled!",
    );
  }

  const passwordOk =
    user.password && (await bcrypt.compare(password, user.password));
  if (!passwordOk || !(await checkCode(user, code))) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid password or code!");
  }

  await query(
    `UPDATE users
     SET two_factor_enabled = false, two_factor_secret = NULL, two_factor_recovery_codes = '{}',
         two_factor_last_step = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1::uuid`,
    [userId],
  );
  invalidateAuthCache(userId);

  return { message: "Two-factor authentication disabled" };
};

export const TwoFactorService = {
  setup,
  enable,
  verifyLogin,
  disable,
};
