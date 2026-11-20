import crypto from "crypto";

// Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 s) for
// authenticator apps such as Google Authenticator, Microsoft Authenticator, 1Password.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export const base32Encode = (buffer: Buffer) => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (input: string) => {
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

export const hotp = (secretBase32: string, counter: number) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto
    .createHmac("sha1", base32Decode(secretBase32))
    .update(buf)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
};

export const currentStep = (now = Date.now()) =>
  Math.floor(now / 1000 / STEP_SECONDS);

// Returns the matching time step (so the caller can reject re-use of the same
// code), or null. Accepts the previous and next step to tolerate clock drift.
export const verifyTotp = (
  secretBase32: string,
  code: string,
  now = Date.now(),
  window = 1,
): number | null => {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const step = currentStep(now);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secretBase32, step + i);
    if (
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))
    ) {
      return step + i;
    }
  }
  return null;
};

export const otpauthUri = (issuer: string, account: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
  `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
