import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { query } from "../../utils/db";
import { assertRecordType, recordLabelSql } from "../../utils/records";
import { defaultPreference, notificationColumns, notificationTypes, pushUnreadCount } from "./notification.shared";

// Notifications (SRS 4.16, FR-MSG-05): the in-app list of what happened that concerns you, and
// the choice per kind of notification: in the app, by email, both or neither. Everyone only
// ever sees their own.

const columns = notificationColumns;

const getNotifications = async (params: Record<string, any>, userId: string) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const conditions = [`n.user_id = $1::uuid`];
  const values: any[] = [userId];
  let n = 2;
  if (String(params.unread) === "true") conditions.push(`n.read_at IS NULL`);
  if (params.type) {
    const types = String(Array.isArray(params.type) ? params.type.join(",") : params.type)
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    if (types.some((t) => !(notificationTypes as readonly string[]).includes(t))) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Type should be one of ${notificationTypes.join(", ")}!`);
    }
    conditions.push(`n.type = ANY($${n++}::text[])`);
    values.push(types);
  }
  const where = conditions.join(" AND ");

  const [rows, count] = await Promise.all([
    query(`SELECT ${columns} FROM notifications n LEFT JOIN users au ON au.id = n.actor_id WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT $${n} OFFSET $${n + 1}`, [...values, limit, skip]),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n.read_at IS NULL)::int AS unread FROM notifications n WHERE ${where}`, values),
  ]);
  const total = count.rows[0].total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: rows.rows,
    totals: { notifications: total, unread: count.rows[0].unread },
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

// The red dots: unread notifications and unread direct messages
const getSummary = async (userId: string) => {
  const result = await query(
    `
      SELECT (SELECT COUNT(*)::int FROM notifications WHERE user_id = $1::uuid AND read_at IS NULL) AS unread_notifications,
             (SELECT COUNT(*)::int FROM messages WHERE kind = 'DIRECT' AND recipient_id = $1::uuid AND read_at IS NULL) AS unread_messages
    `,
    [userId],
  );
  return result.rows[0];
};

const markRead = async (id: string, userId: string) => {
  assertUuid(id, "notification id");
  const found = await query(`SELECT id FROM notifications WHERE id = $1::uuid AND user_id = $2::uuid`, [id, userId]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Notification not found!");
  }
  // reading twice is fine: the first reading time stays
  await query(`UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = $1::uuid`, [id]);
  await pushUnreadCount(userId, { read: [id] });
  const read = await query(`SELECT ${columns} FROM notifications n LEFT JOIN users au ON au.id = n.actor_id WHERE n.id = $1::uuid`, [id]);
  return read.rows[0];
};

const markAllRead = async (userId: string, type?: string) => {
  const values: any[] = [userId];
  let extra = "";
  if (type) {
    if (!(notificationTypes as readonly string[]).includes(type.toUpperCase())) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Type should be one of ${notificationTypes.join(", ")}!`);
    }
    values.push(type.toUpperCase());
    extra = ` AND type = $2`;
  }
  const result = await query(`UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = $1::uuid AND read_at IS NULL${extra} RETURNING id`, values);
  await pushUnreadCount(userId, { read: result.rows.map((r: any) => r.id) });
  return { marked: result.rows.length };
};

// Called when someone opens a record: its notifications (a new inquiry, a mention) are done
// ("highlighted until opened", FR-DASH-02)
const markRecordRead = async (entity: { type: string; id: string }, userId: string) => {
  const type = assertRecordType(entity.type);
  assertUuid(entity.id, "record id");
  const result = await query(
    `UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = $1::uuid AND entity_type = $2 AND entity_id = $3::uuid AND read_at IS NULL RETURNING id`,
    [userId, type, entity.id],
  );
  if (result.rows.length > 0) await pushUnreadCount(userId, { read: result.rows.map((r: any) => r.id) });
  return { marked: result.rows.length };
};

const deleteNotification = async (id: string, userId: string) => {
  assertUuid(id, "notification id");
  const result = await query(`DELETE FROM notifications WHERE id = $1::uuid AND user_id = $2::uuid RETURNING id`, [id, userId]);
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Notification not found!");
  }
  await pushUnreadCount(userId, { deleted: [id] });
};

// Removes the ones already read
const clearRead = async (userId: string) => {
  const result = await query(`DELETE FROM notifications WHERE user_id = $1::uuid AND read_at IS NOT NULL RETURNING id`, [userId]);
  await pushUnreadCount(userId, { deleted: result.rows.map((r: any) => r.id) });
  return { deleted: result.rows.length };
};

// ---------------------------------------------------------------------------
// Settings per user (FR-MSG-05)
// ---------------------------------------------------------------------------

// Every kind of notification with the value that applies (what they chose, or the default)
const getPreferences = async (userId: string) => {
  const saved = await query(`SELECT type, in_app, email FROM notification_preferences WHERE user_id = $1::uuid`, [userId]);
  const byType = new Map<string, { in_app: boolean; email: boolean }>(saved.rows.map((r: any) => [r.type, r]));
  return notificationTypes.map((type) => ({
    type,
    in_app: byType.get(type)?.in_app ?? defaultPreference.in_app,
    email: byType.get(type)?.email ?? defaultPreference.email,
    is_default: !byType.has(type),
  }));
};

const setPreferences = async (userId: string, preferences: { type: string; in_app?: boolean; email?: boolean }[]) => {
  const seen = new Set<string>();
  for (const p of preferences) {
    if (seen.has(p.type)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${p.type} is given twice!`);
    }
    seen.add(p.type);
  }
  for (const p of preferences) {
    // A value that is not given keeps what applies now
    await query(
      `
        INSERT INTO notification_preferences (user_id, type, in_app, email)
        VALUES ($1::uuid, $2, COALESCE($3::boolean, $5::boolean), COALESCE($4::boolean, $6::boolean))
        ON CONFLICT (user_id, type) DO UPDATE SET
          in_app = COALESCE($3::boolean, notification_preferences.in_app),
          email = COALESCE($4::boolean, notification_preferences.email)
      `,
      [userId, p.type, p.in_app ?? null, p.email ?? null, defaultPreference.in_app, defaultPreference.email],
    );
  }
  return getPreferences(userId);
};

export const NotificationService = {
  getNotifications,
  getSummary,
  markRead,
  markAllRead,
  markRecordRead,
  deleteNotification,
  clearRead,
  getPreferences,
  setPreferences,
};
