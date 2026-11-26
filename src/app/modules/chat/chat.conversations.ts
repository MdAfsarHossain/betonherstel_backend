import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { isConnected } from "../../lib/realtime";
import assertUuid from "../../utils/assertUuid";
import { query, transaction } from "../../utils/db";
import { paginationHelper } from "../../helpers/paginationHelper";
import {
  conversationItems,
} from "./chat.conversations.list";
import {
  employeeRoles,
  IChatChannel,
  IChatUser,
  isConversationKind,
  MAX_GROUP_MEMBERS,
  roleLabels,
} from "./chat.interface";
import { pushConversationList } from "./chat.live";
import {
  isEmployee,
  loadChatUser,
  notFound,
  requireChannel,
} from "./chat.shared";

// Staff chats: a one-to-one chat (DIRECT) or a named group (GROUP) between employees (Admin, Office, Field crew).
// They belong to no project and are private to their members: `canAccess` (chat.shared.ts) gives office and admin
// no way in. Messages, reading, typing and presence use the same /chat/channels/:id routes as a project chat.

const requireEmployee = async (userId: string) => {
  const user = await loadChatUser(userId);
  if (!isEmployee(user.role)) throw notFound();
  return user;
};

// A conversation I am in (a project channel, or one I may not see, answers 404 here)
const requireConversation = async (user: IChatUser, channelId: string) => {
  const channel = await requireChannel(user, channelId);
  if (!isConversationKind(channel.kind)) throw notFound();
  return channel;
};

const requireOwner = async (user: IChatUser, channel: IChatChannel) => {
  if (channel.kind !== "GROUP")
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "A direct chat cannot be changed!",
    );
  const owner = await query(
    `SELECT 1 FROM chat_members WHERE channel_id = $1::uuid AND user_id = $2::uuid AND is_owner`,
    [channel.id, user.id],
  );
  if (owner.rows.length === 0)
    throw new ApiError(
      httpStatus.FORBIDDEN,
      "Only the person who owns the group can do this!",
    );
};

const memberIds = async (channelId: string) =>
  (
    await query(
      `SELECT user_id FROM chat_members WHERE channel_id = $1::uuid`,
      [channelId],
    )
  ).rows.map((r: any) => r.user_id as string);

// Active employees that can be put in a chat (never an inactive account, a customer or a subcontractor)
const assertActiveEmployees = async (ids: string[]) => {
  ids.forEach((id) => assertUuid(id, "user id"));
  const found = await query(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`,
    [ids, [...employeeRoles]],
  );
  if (found.rows.length !== new Set(ids).size) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Only active employees can be in a chat!",
    );
  }
};

const itemFor = async (user: IChatUser, channelId: string) => {
  const [item] = await conversationItems(user, [channelId]);
  if (!item) throw notFound();
  return item;
};

// Who I can start a chat with
const getPeople = async (userId: string, params: Record<string, any>) => {
  const user = await requireEmployee(userId);
  const { page, limit, skip } = paginationHelper.calculatePagination(
    params as any,
  );
  const values: any[] = [user.id, [...employeeRoles]];
  let search = "";
  if (params.searchTerm) {
    values.push(
      `%${String(params.searchTerm)
        .trim()
        .replace(/[%_\\]/g, "\\$&")}%`,
    );
    search = ` AND u.name ILIKE $${values.length}`;
  }
  const where = `WHERE u.id <> $1::uuid AND u.is_active AND u.status = 'ACTIVE' AND u.role::text = ANY($2::text[])${search}`;
  const [rows, count] = await Promise.all([
    query(
      `SELECT u.id, u.name, u.role::text AS role, u.avatar FROM users u ${where} ORDER BY u.name, u.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, skip],
    ),
    query(`SELECT COUNT(*)::int AS total FROM users u ${where}`, values),
  ]);
  const totalPage = Math.ceil(count.rows[0].total / limit);
  return {
    data: rows.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      role_label: roleLabels[r.role] ?? r.role,
      avatar: r.avatar ?? null,
      online: isConnected(r.id),
    })),
    meta: {
      page,
      limit,
      total: count.rows[0].total,
      totalPage,
      hasNextPage: page < totalPage,
      hasPrevPage: page > 1,
    },
  };
};

const getConversation = async (userId: string, channelId: string) => {
  const user = await requireEmployee(userId);
  await requireConversation(user, channelId);
  return itemFor(user, channelId);
};

// The one chat between two people: found if it exists, else made. Safe to call twice at once (unique `direct_key`).
const startDirect = async (userId: string, targetId: string) => {
  const user = await requireEmployee(userId);
  assertUuid(targetId, "user id");
  if (targetId === user.id)
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "You cannot start a chat with yourself!",
    );
  await assertActiveEmployees([targetId]);

  const key = [user.id, targetId].sort().join(":");
  const created = await query(
    `INSERT INTO chat_channels (kind, direct_key, created_by) VALUES ('DIRECT', $1, $2::uuid)
     ON CONFLICT (direct_key) WHERE direct_key IS NOT NULL DO NOTHING RETURNING id`,
    [key, user.id],
  );
  const channelId: string =
    created.rows[0]?.id ??
    (await query(`SELECT id FROM chat_channels WHERE direct_key = $1`, [key]))
      .rows[0].id;
  await query(
    `INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid) ON CONFLICT DO NOTHING`,
    [channelId, user.id, targetId],
  );
  // the other person sees the chat appear in their list (a chat nobody has written in is only shown to its starter
  // by the app until the first message, but both lists are correct)
  await pushConversationList([user.id, targetId], channelId);
  return {
    ...(await itemFor(user, channelId)),
    created: created.rows.length > 0,
  };
};

const createGroup = async (
  userId: string,
  input: { title: string; member_ids: string[] },
) => {
  const user = await requireEmployee(userId);
  const others = [...new Set(input.member_ids)].filter((id) => id !== user.id);
  if (others.length === 0)
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Choose at least one other person!",
    );
  if (others.length + 1 > MAX_GROUP_MEMBERS) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `A group can have at most ${MAX_GROUP_MEMBERS} people!`,
    );
  }
  await assertActiveEmployees(others);

  const channelId = await transaction(async (client) => {
    const channel = await client.query(
      `INSERT INTO chat_channels (kind, title, created_by) VALUES ('GROUP', $1, $2::uuid) RETURNING id`,
      [input.title.trim(), user.id],
    );
    const id = channel.rows[0].id as string;
    await client.query(
      `INSERT INTO chat_members (channel_id, user_id, added_by, is_owner) VALUES ($1::uuid, $2::uuid, $2::uuid, true)`,
      [id, user.id],
    );
    await client.query(
      `INSERT INTO chat_members (channel_id, user_id, added_by) SELECT $1::uuid, x, $2::uuid FROM unnest($3::uuid[]) AS x`,
      [id, user.id, others],
    );
    return id;
  });
  await pushConversationList([user.id, ...others], channelId);
  return itemFor(user, channelId);
};

const renameGroup = async (
  userId: string,
  channelId: string,
  title: string,
) => {
  const user = await requireEmployee(userId);
  const channel = await requireConversation(user, channelId);
  await requireOwner(user, channel);
  await query(`UPDATE chat_channels SET title = $2 WHERE id = $1::uuid`, [
    channel.id,
    title.trim(),
  ]);
  await pushConversationList(await memberIds(channel.id), channel.id);
  return itemFor(user, channel.id);
};

const addMember = async (
  userId: string,
  channelId: string,
  memberId: string,
) => {
  const user = await requireEmployee(userId);
  const channel = await requireConversation(user, channelId);
  await requireOwner(user, channel);
  await assertActiveEmployees([memberId]);
  const current = await memberIds(channel.id);
  if (!current.includes(memberId)) {
    if (current.length >= MAX_GROUP_MEMBERS) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `A group can have at most ${MAX_GROUP_MEMBERS} people!`,
      );
    }
    await query(
      `INSERT INTO chat_members (channel_id, user_id, added_by) VALUES ($1::uuid, $2::uuid, $3::uuid) ON CONFLICT DO NOTHING`,
      [channel.id, memberId, user.id],
    );
  }
  await pushConversationList(await memberIds(channel.id), channel.id);
  return itemFor(user, channel.id);
};

// The owner removes someone, or anyone leaves (removes themselves). When the owner goes, the longest-standing member takes over.
const removeMember = async (
  userId: string,
  channelId: string,
  memberId: string,
) => {
  const user = await requireEmployee(userId);
  const channel = await requireConversation(user, channelId);
  assertUuid(memberId, "user id");
  if (channel.kind !== "GROUP")
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "A direct chat cannot be changed!",
    );
  if (memberId !== user.id) await requireOwner(user, channel);

  const removed = await query(
    `DELETE FROM chat_members WHERE channel_id = $1::uuid AND user_id = $2::uuid RETURNING is_owner`,
    [channel.id, memberId],
  );
  if (removed.rows.length === 0)
    throw new ApiError(
      httpStatus.NOT_FOUND,
      "This person is not in the group!",
    );
  const remaining = await memberIds(channel.id);
  if (removed.rows[0].is_owner && remaining.length > 0) {
    await query(
      `UPDATE chat_members SET is_owner = true
       WHERE channel_id = $1::uuid AND user_id = (SELECT user_id FROM chat_members WHERE channel_id = $1::uuid ORDER BY created_at, user_id LIMIT 1)`,
      [channel.id],
    );
  }
  // the person who left or was removed gets `item: null` (and stops watching the chat)
  await pushConversationList([...remaining, memberId], channel.id);
  if (memberId === user.id) return { channel_id: channel.id, left: true };
  return itemFor(user, channel.id);
};

export const ChatConversationService = {
  getPeople,
  getConversation,
  startDirect,
  createGroup,
  renameGroup,
  addMember,
  removeMember,
};
