// Firebase service account for push notifications (FCM).
//
// The credentials must NEVER be written in the source code (the repository history is not a safe
// place for a private key). Provide them through the environment:
//   FIREBASE_SERVICE_ACCOUNT = the service-account JSON, either as plain JSON or base64-encoded
// Without it push notifications are simply switched off.

const load = (): Record<string, any> | null => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw) return null;
  try {
    const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT is not valid JSON (or base64 of JSON): push notifications are off");
    return null;
  }
};

export const serviceAccount = load();
