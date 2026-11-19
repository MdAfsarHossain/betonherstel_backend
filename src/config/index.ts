import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env") });

export default {
  env: process.env.NODE_ENV,
  port: process.env.PORT,
  super_admin_password: process.env.SUPER_ADMIN_PASSWORD,
  // Public URL of the web app (links in emails: password reset, portal invitations)
  frontend_url: (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, ""),
  // Public URL of this server. Mollie calls back here when a payment changes (https://.../webhooks/mollie)
  base_url: (process.env.BASE_URL || "").replace(/\/+$/, ""),
  // 64 hex characters (32 bytes). Encrypts secrets stored in the database (2FA, Mollie, SnelStart).
  // Generate one with: openssl rand -hex 32
  encryption_key: process.env.ENCRYPTION_KEY,
  // Two-factor authentication is mandatory for admins (FR-AUTH-04). Set to "false" for local dev only.
  admin_2fa_required: process.env.ADMIN_2FA_REQUIRED !== "false",
  password_reset_expires_minutes: Number(process.env.PASSWORD_RESET_EXPIRES_MINUTES) || 60,
  bcrypt_salt_rounds: process.env.BCRYPT_SALT_ROUNDS || "12",
  otp_expiry_time: process.env.OTP_ACCESS_EXPIRES_IN || "5",
  jwt: {
    access_secret: process.env.JWT_ACCESS_SECRET,
    access_expires_in: process.env.JWT_ACCESS_EXPIRES_IN,
    refresh_secret: process.env.JWT_REFRESH_SECRET,
    refresh_expires_in: process.env.JWT_REFRESH_EXPIRES_IN,

    reset_pass_secret: process.env.JWT_RESET_PASS_SECRET,
    reset_pass_token_expires_in: process.env.JWT_RESET_PASS_EXPIRES_IN,
    store_address_token_expires_in: process.env.JWT_STORE_ADDRESS_EXPIRES_IN,
  },
  S3: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
    region: process.env.S3_REGION,
    bucketName: process.env.S3_BUCKET_NAME,
    endpoint: process.env.S3_ENDPOINT,
  },  
  emailSender: {
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port: Number(process.env.EMAIL_PORT) || 587,
    email: process.env.EMAIL,
    app_pass: process.env.EMAIL_PASSWORD,
    contact_mail_address: process.env.CONTACT_MAIL_ADDRESS,
}
}
