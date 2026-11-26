import { paginationHelper } from "../../helpers/paginationHelper";
import { query } from "../../utils/db";
import { IChatUser, roleLabels } from "./chat.interface";
import { unreadSql } from "./chat.shared";

// The staff chat list (DIRECT and GROUP conversations). One builder serves `GET /chat/conversations` and the live
// `chat:chat` (type "single" / "group") and the merged `chat:chats` pushes, so the two can never differ. A conversation is only listed
// for its members: being office or admin gives no access to other people's chats.

const memberOf = `EXISTS (SELECT 1 FROM chat_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1::uuid)`;

const itemSelect = `
  SELECT c.id, c.kind, c.title, c.created_by, c.created_at AS "createdAt",
         ${unreadSql("c.id", "$1")} AS unread,
         (SELECT json_build_object(
            'id', m.id, 'createdAt', m.created_at, 'author_id', m.author_id, 'author', u.name,
            'preview', left(m.body, 160))
          FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
          WHERE m.channel_id = c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
         (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS last_at,
         COALESCE((
           SELECT json_agg(json_build_object('id', pu.id, 'name', pu.name, 'role', pu.role::text, 'avatar', pu.avatar, 'is_owner', pm.is_owner)
                           ORDER BY pu.name)
           FROM chat_members pm JOIN users pu ON pu.id = pm.user_id WHERE pm.channel_id = c.id
         ), '[]'::json) AS participants
  FROM chat_channels c
`;

// How a conversation looks to one person: a DIRECT chat is titled with the other person's name
const shapeItem = (row: any, userId: string) => {
  const participants = (row.participants as any[]).map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    role_label: roleLabels[p.role] ?? p.role,
    avatar: p.avatar ?? null,
    is_owner: !!p.is_owner,
    is_me: p.id === userId,
  }));
  const other = participants.find((p) => !p.is_me);
  return {
    type: row.kind === "DIRECT" ? "single" : "group",
    id: row.id,
    title: row.kind === "DIRECT" ? (other?.name ?? "Former colleague") : (row.title ?? "Group"),
    participants,
    unread: row.unread,
    last_message_at: row.last_at ? new Date(row.last_at).toISOString() : null,
    // its newest message, or its creation when that is newer: a chat that was just created is first
    activity_at: new Date(Math.max(+new Date(row.createdAt), row.last_at ? +new Date(row.last_at) : 0)).toISOString(),
    last_message: row.last_message,
    is_owner: participants.some((p) => p.is_me && p.is_owner),
    createdAt: row.createdAt,
  };
};

// One person's own entry for the given conversations (null for one they are not in)
export const conversationItems = async (user: IChatUser, channelIds: string[]) => {
  if (channelIds.length === 0) return [];
  const result = await query(
    `${itemSelect} WHERE c.id = ANY($2::uuid[]) AND c.kind IN ('DIRECT', 'GROUP') AND ${memberOf}`,
    [user.id, channelIds],
  );
  return result.rows.map((row: any) => shapeItem(row, user.id));
};

const paged = (rows: any[], total: number, page: number, limit: number) => {
  const totalPage = Math.ceil(total / limit);
  return { data: rows, meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 } };
};

// A person's whole conversation list, one page, the newest message first (chats nobody has written in yet after them)
// `params.type` can narrow it to "single" or "group"; `window` replaces page / limit with an exact slice
export const listConversations = async (user: IChatUser, params: Record<string, any>, window?: { limit: number; skip: number }) => {
  const pagination = paginationHelper.calculatePagination(params as any);
  const { page } = pagination;
  const limit = window?.limit ?? pagination.limit;
  const skip = window?.skip ?? pagination.skip;

  const values: any[] = [user.id];
  let search = "";
  if (params.searchTerm) {
    values.push(`%${String(params.searchTerm).trim().replace(/[%_\\]/g, "\\$&")}%`);
    search = ` AND (c.title ILIKE $${values.length} OR EXISTS (
      SELECT 1 FROM chat_members sm JOIN users su ON su.id = sm.user_id
      WHERE sm.channel_id = c.id AND sm.user_id <> $1::uuid AND su.name ILIKE $${values.length}))`;
  }
  const onlyUnread = String(params.unread) === "true" ? ` AND ${unreadSql("c.id", "$1")} > 0` : "";
  const kinds = params.type === "single" ? "'DIRECT'" : params.type === "group" ? "'GROUP'" : "'DIRECT', 'GROUP'";
  const where = `WHERE c.kind IN (${kinds}) AND ${memberOf}${search}${onlyUnread}`;

  const [rows, count] = await Promise.all([
    query(
      `${itemSelect} ${where}
       ORDER BY GREATEST((SELECT MAX(m.created_at) FROM chat_messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL), c.created_at) DESC,
                c.id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, skip],
    ),
    query(`SELECT COUNT(*)::int AS total FROM chat_channels c ${where}`, values),
  ]);
  return paged(rows.rows.map((row: any) => shapeItem(row, user.id)), count.rows[0].total, page, limit);
};

// Unread messages over all of a person's staff chats
export const conversationUnread = async (userId: string) => {
  const r = await query(
    `SELECT COALESCE(SUM(x.unread), 0)::int AS unread, COUNT(*) FILTER (WHERE x.unread > 0)::int AS with_unread
     FROM (SELECT ${unreadSql("c.id", "$1")} AS unread FROM chat_channels c
           WHERE c.kind IN ('DIRECT', 'GROUP') AND ${memberOf}) x`,
    [userId],
  );
  return r.rows[0] as { unread: number; with_unread: number };
};
