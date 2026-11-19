import config from "../../config";

// Two-factor authentication is mandatory for the Beheerder (FR-AUTH-04) and
// optional for everyone else. Set ADMIN_2FA_REQUIRED=false to switch the
// requirement off for local development.
export const requiresTwoFactor = (role: string) =>
  config.admin_2fa_required && (role === "ADMIN" || role === "SUPERADMIN");
