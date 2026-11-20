import crypto from "crypto";
import httpStatus from "http-status";
import config from "../../config";
import ApiError from "../errors/ApiError";

// AES-256-GCM encryption for secrets stored in the database
// (2FA secrets, and later the Mollie and SnelStart keys: NFR-SEC-07).
// Stored format: v1:<iv>:<auth tag>:<ciphertext>, each part base64.

const getKey = () => {
  const key = config.encryption_key;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "ENCRYPTION_KEY is missing or invalid. Set it to 64 hex characters (openssl rand -hex 32).",
    );
  }
  return Buffer.from(key, "hex");
};

export const encrypt = (plain: string) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
};

export const decrypt = (payload: string) => {
  const [version, iv, tag, data] = payload.split(":");
  if (version !== "v1" || !iv || !tag || !data) {
    throw new Error("Unsupported encrypted value");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
};
