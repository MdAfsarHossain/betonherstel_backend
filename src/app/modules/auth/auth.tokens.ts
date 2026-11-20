import { Secret } from "jsonwebtoken";
import httpStatus from "http-status";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import { jwtHelpers } from "../../helpers/jwtHelpers";
import { ISession } from "./auth.interface";

type TTwoFactorPurpose = "2fa-login" | "2fa-setup";

const signIn = (user: { id: string; email: string; role: string }) => ({
  id: user.id,
  email: user.email as string,
  role: user.role,
});

export const issueSessionTokens = (user: {
  id: string;
  email: string;
  role: string;
}) => ({
  accessToken: jwtHelpers.generateToken(
    signIn(user),
    config.jwt.access_secret as Secret,
    config.jwt.access_expires_in as string,
  ),
  refreshToken: jwtHelpers.generateToken(
    signIn(user),
    config.jwt.refresh_secret as Secret,
    config.jwt.refresh_expires_in as string,
  ),
});

// Short-lived tokens used between the password step and the 2FA step. They are
// signed with a secret derived from the access secret, so they can never be
// accepted as an access token (or a reset token).
const twoFactorSecret = () => {
  if (!config.jwt.access_secret) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "JWT secret is not configured");
  }
  return `${config.jwt.access_secret}:two-factor` as Secret;
};

export const issueTwoFactorToken = (
  user: { id: string },
  purpose: TTwoFactorPurpose,
) =>
  jwtHelpers.generateToken(
    { id: user.id, purpose },
    twoFactorSecret(),
    purpose === "2fa-login" ? "5m" : "15m",
  );

// Returns the user id, or throws 401 when the token is wrong, expired or for another purpose
export const verifyTwoFactorToken = (
  token: string,
  purpose: TTwoFactorPurpose,
): string => {
  try {
    const payload = jwtHelpers.verifyToken(token, twoFactorSecret());
    if (payload.purpose !== purpose || !payload.id) throw new Error("purpose");
    return payload.id as string;
  } catch {
    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      "This step has expired. Please sign in again!",
    );
  }
};

// The response a fully signed-in user gets: profile fields plus both tokens
export const buildSession = (user: any): ISession => {
  const { accessToken, refreshToken } = issueSessionTokens(user);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone_number: user.phone_number,
    address: user.address,
    date_of_birth: user.date_of_birth,
    role: user.role,
    avatar: user.avatar,
    status: user.status,
    preferred_language: user.preferred_language,
    accessToken,
    refreshToken,
  };
};
