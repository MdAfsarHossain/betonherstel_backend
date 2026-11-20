// What a file really is, from its first bytes (the browser's Content-Type can be
// wrong or forged). Only JPEG, PNG, WebP and PDF are accepted anywhere in the CRM.
export const detectFileType = (buffer: Buffer): { mime: string } | null => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg" };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png" };
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { mime: "application/pdf" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return { mime: "image/webp" };
  }
  return null;
};
