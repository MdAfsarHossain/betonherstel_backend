import crypto from "crypto";
import { query } from "../../utils/db";
import { buildIcs, IIcsEvent } from "../../utils/ical";
import { toLanguage, TLanguage } from "../../utils/i18n";
import { appointmentTypeLabels, TAppointmentType } from "./planning.interface";

// Calendar subscription (FR-PLAN-08). Google and Apple Calendar cannot log in, so each
// employee gets a private link with a secret in it. They add it once ("subscribe to
// calendar by URL") and their planning stays up to date, read-only. The link
// can be replaced or switched off at any time; only a hash of the secret is stored.

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

// Creates a new link secret, replacing the old one. The secret is shown only now.
const createToken = async (userId: string) => {
  const token = crypto.randomBytes(32).toString("hex");
  await query(
    `
      INSERT INTO calendar_tokens (user_id, token_hash) VALUES ($1::uuid, $2)
      ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = CURRENT_TIMESTAMP
    `,
    [userId, hash(token)],
  );
  return token;
};

const getTokenInfo = async (userId: string) => {
  const result = await query(`SELECT created_at AS "createdAt" FROM calendar_tokens WHERE user_id = $1::uuid`, [userId]);
  return { enabled: result.rows.length > 0, createdAt: result.rows[0]?.createdAt ?? null };
};

const revokeToken = async (userId: string) => {
  await query(`DELETE FROM calendar_tokens WHERE user_id = $1::uuid`, [userId]);
};

const labels: Record<TLanguage, { customer: string; contact: string; notes: string }> = {
  NL: { customer: "Klant", contact: "Contact", notes: "Opmerkingen" },
  EN: { customer: "Customer", contact: "Contact", notes: "Notes" },
};

// The calendar file for the person behind this secret, or null if the secret is not valid.
// Covers the last 30 days and the next 400. Cancelled appointments are included as
// cancelled so subscribed calendars drop them.
const buildFeed = async (token: string) => {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  const owner = await query(
    `
      SELECT u.id, u.name, u.preferred_language
      FROM calendar_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND u.is_active AND u.status = 'ACTIVE'
    `,
    [hash(token)],
  );
  if (owner.rows.length === 0) return null;
  const user = owner.rows[0];
  const language = toLanguage(user.preferred_language);

  const result = await query(
    `
      SELECT a.id, a.type, a.status, a.title, a.starts_at, a.ends_at, a.all_day, a.notes, a.updated_at,
             a.street, a.house_number, a.postcode, a.city,
             r.name AS customer_name,
             COALESCE(pj.contact_name, i.contact_name, pc.name, r.name) AS contact_name,
             COALESCE(pj.contact_phone, i.contact_phone, pc.phone, r.phone) AS contact_phone
      FROM appointments a
      JOIN appointment_assignees mine ON mine.appointment_id = a.id AND mine.user_id = $1::uuid
      LEFT JOIN relations r ON r.id = a.relation_id
      LEFT JOIN inquiries i ON i.id = a.inquiry_id
      LEFT JOIN projects pj ON pj.id = a.project_id
      LEFT JOIN relation_contacts pc ON pc.relation_id = r.id AND pc.is_primary
      WHERE a.ends_at > CURRENT_TIMESTAMP - INTERVAL '30 days'
        AND a.starts_at < CURRENT_TIMESTAMP + INTERVAL '400 days'
      ORDER BY a.starts_at ASC
    `,
    [user.id],
  );

  const events: IIcsEvent[] = result.rows.map((a: any) => {
    const typeLabel = appointmentTypeLabels[a.type as TAppointmentType][language];
    const description = [
      `${typeLabel}`,
      a.customer_name ? `${labels[language].customer}: ${a.customer_name}` : null,
      a.contact_name && a.contact_phone ? `${labels[language].contact}: ${a.contact_name}, ${a.contact_phone}` : null,
      a.notes ? `${labels[language].notes}: ${a.notes}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      uid: `${a.id}@betonherstel`,
      start: new Date(a.starts_at),
      end: new Date(a.ends_at),
      allDay: a.all_day,
      summary: a.title,
      location: [[a.street, a.house_number].filter(Boolean).join(" "), [a.postcode, a.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null,
      description,
      status: a.status === "CANCELLED" ? "CANCELLED" : "CONFIRMED",
      updated: new Date(a.updated_at),
    };
  });

  return buildIcs(events, `Betonherstel planning - ${user.name}`);
};

export const PlanningIcalService = {
  createToken,
  getTokenInfo,
  revokeToken,
  buildFeed,
};
