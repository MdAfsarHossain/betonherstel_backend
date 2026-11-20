import config from "../../../config";
import { query } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { toLanguage } from "../../utils/i18n";
import { recordLabelSql, recordWebPath, TRecordType } from "../../utils/records";
import { emitToUser, unreadCountOf } from "../../lib/realtime";

// What a notification looks like in the list and in the live push (one shape for both)
export const notificationColumns = `
  n.id, n.type, n.title, n.body, n.data, n.read_at, n.created_at AS "createdAt",
  (n.read_at IS NULL) AS is_unread,
  CASE WHEN n.actor_id IS NULL THEN NULL ELSE json_build_object('id', au.id, 'name', au.name) END AS actor,
  CASE WHEN n.entity_type IS NULL THEN NULL ELSE json_build_object('type', n.entity_type, 'id', n.entity_id, 'label', ${recordLabelSql("n.entity_type", "n.entity_id")}) END AS entity
`;

// Tells the person's open browser tabs what changed in their notification list: which ones were read
// (`notification:read` { ids }) or deleted (`notification:deleted` { ids }), and always the new unread count
// (`notification:unread`). Several tabs, or the phone and the laptop, stay in sync without refetching.
export const pushUnreadCount = async (userId: string, change: { read?: string[]; deleted?: string[] } = {}) => {
  try {
    if (change.read?.length) emitToUser(userId, "notification:read", { ids: change.read });
    if (change.deleted?.length) emitToUser(userId, "notification:deleted", { ids: change.deleted });
    emitToUser(userId, "notification:unread", { unread_notifications: await unreadCountOf(userId) });
  } catch {
    // live push is a convenience: never fail the request that caused it
  }
};

// Pushes a just-saved notification to its recipient
const pushNotification = async (userId: string, notificationId: string) => {
  try {
    const row = await query(`SELECT ${notificationColumns} FROM notifications n LEFT JOIN users au ON au.id = n.actor_id WHERE n.id = $1::uuid`, [notificationId]);
    if (row.rows.length === 0) return;
    emitToUser(userId, "notification:new", { notification: row.rows[0], unread_notifications: await unreadCountOf(userId) });
  } catch {
    // the notification is saved; the web app also gets it over REST
  }
};

// Notifications (SRS 4.16, FR-MSG-05). Other modules call `notify` when something happens that a
// person should know about. It respects each user's settings (in the app and / or by email) and,
// like automatic tasks, it **never throws**: a notification must never make the event fail.

export const notificationTypes = [
  "MESSAGE",
  "MENTION",
  "ACTION_ASSIGNED",
  "NEW_INQUIRY",
  "QUOTE_ACCEPTED",
  "QUOTE_REJECTED",
  "ASSIGNMENT_RESPONSE",
  "PORTAL_MESSAGE",
  "ASSIGNMENT_UPDATE",
  "SUBSCRIPTION_UPDATE",
  "CHAT_MESSAGE",
  "SNELSTART_SYNC",
  "APPOINTMENT_COMPLETED",
  "APPOINTMENT_ASSIGNED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "WORK_ORDER_ASSIGNED",
  "WORK_ORDER_CHANGED",
] as const;
export type TNotificationType = (typeof notificationTypes)[number];

// What a user gets until they choose otherwise: everything in the app, nothing by email
export const defaultPreference = { in_app: true, email: false };

const internalRoles = ["SUPERADMIN", "ADMIN", "OFFICE", "FIELD"];
const staffRoles = ["SUPERADMIN", "ADMIN", "OFFICE"];

export interface INotification {
  type: TNotificationType;
  title: string;
  body?: string | null;
  entity?: { type: TRecordType; id: string } | null;
  // anything the web app needs to open the right thing (a message id, a task id)
  data?: Record<string, any>;
  // the person who caused it never notifies themselves
  actorId?: string | null;
}

const preview = (text: string | null | undefined, max = 300) => {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const linkFor = (n: INotification) => {
  if (n.entity) return `${config.frontend_url}${recordWebPath(n.entity.type, n.entity.id)}`;
  if (n.type === "MESSAGE") return `${config.frontend_url}/messages`;
  if (n.type === "ACTION_ASSIGNED") return `${config.frontend_url}/actions`;
  return `${config.frontend_url}/notifications`;
};

export const notify = async (recipientIds: (string | null | undefined)[], n: INotification): Promise<number> => {
  try {
    const ids = [...new Set(recipientIds.filter((id): id is string => !!id && id !== n.actorId))];
    if (ids.length === 0) return 0;

    // Only active employees
    const users = await query(
      `SELECT id, name, email, preferred_language FROM users
       WHERE id = ANY($1::uuid[]) AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`,
      [ids, internalRoles],
    );
    if (users.rows.length === 0) return 0;
    const prefs = await query(`SELECT user_id, in_app, email FROM notification_preferences WHERE user_id = ANY($1::uuid[]) AND type = $2`, [
      users.rows.map((u: any) => u.id),
      n.type,
    ]);
    const prefOf = new Map<string, { in_app: boolean; email: boolean }>(prefs.rows.map((p: any) => [p.user_id, p]));

    let made = 0;
    const emails: Promise<unknown>[] = [];
    for (const user of users.rows) {
      const pref = prefOf.get(user.id) ?? defaultPreference;
      if (pref.in_app) {
        const saved = await query(
          `INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, data, actor_id)
           VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $8::uuid) RETURNING id`,
          [user.id, n.type, n.title.slice(0, 255), preview(n.body), n.entity?.type ?? null, n.entity?.id ?? null, JSON.stringify(n.data ?? {}), n.actorId ?? null],
        );
        made++;
        // Live: the recipient's open tabs get it now (after the save, so a push is never ahead of the data)
        await pushNotification(user.id, saved.rows[0].id);
      }
      if (pref.email) {
        emails.push(
          sendTemplatedEmail({
            to: user.email,
            templateKey: "notification",
            language: toLanguage(user.preferred_language),
            variables: { name: user.name, title: n.title, body: preview(n.body, 500) ?? "", link: linkFor(n) },
            related: n.entity ? { type: n.entity.type, id: n.entity.id } : undefined,
            sentBy: n.actorId ?? null,
            // Handled at once: the loop awaits database work before allSettled, and an unhandled
            // rejection in between would stop the whole server
          }).catch(() => undefined),
        );
      }
    }
    // A failing email is logged by the email service and never fails the notification
    await Promise.allSettled(emails);
    return made;
  } catch (error: any) {
    console.error("❌ Could not create the notification:", error?.message ?? error);
    return 0;
  }
};

// All active office employees (Beheerder + Kantoor): "the team"
export const officeUserIds = async (): Promise<string[]> => {
  const result = await query(`SELECT id FROM users WHERE is_active AND status = 'ACTIVE' AND role::text IN ('ADMIN', 'OFFICE')`);
  return result.rows.map((r: any) => r.id);
};

export const isStaffRole = (role: string) => staffRoles.includes(role);

// A quotation was answered: tell the person who made it, or the office if they are gone
export const notifyAboutQuote = async (quoteId: string, outcome: "ACCEPTED" | "REJECTED", actorId: string | null, detail?: string | null) => {
  try {
    const found = await query(
      `
        SELECT q.id, q.number, q.title, q.created_by, r.name AS relation_name
        FROM quotes q JOIN relations r ON r.id = q.relation_id WHERE q.id = $1::uuid
      `,
      [quoteId],
    );
    const quote = found.rows[0];
    if (!quote) return;
    const owner = quote.created_by
      ? await query(`SELECT id FROM users WHERE id = $1::uuid AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`, [quote.created_by, staffRoles])
      : { rows: [] };
    const recipients = owner.rows.length > 0 ? [quote.created_by] : await officeUserIds();
    await notify(recipients, {
      type: outcome === "ACCEPTED" ? "QUOTE_ACCEPTED" : "QUOTE_REJECTED",
      title: `Quotation ${quote.number} ${outcome === "ACCEPTED" ? "accepted" : "rejected"} by ${quote.relation_name}`,
      body: detail ?? quote.title,
      entity: { type: "quote", id: quote.id },
      actorId,
    });
  } catch (error: any) {
    console.error("❌ Could not notify about the quotation:", error?.message ?? error);
  }
};
