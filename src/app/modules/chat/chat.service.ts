import httpStatus from "http-status";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { emitToUser } from "../../lib/realtime";
import assertUuid from "../../utils/assertUuid";
import { query } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { toLanguage } from "../../utils/i18n";
import { notify, pushUnreadCount } from "../messages/notification.shared";
import { ProjectService } from "../project/project.service";
import {
  channelLabels,
  EDIT_WINDOW_MINUTES,
  EMAIL_EVERY_MINUTES,
  IChatChannel,
  IChatUser,
  MAX_BODY_LENGTH,
  MAX_FILES_PER_MESSAGE,
} from "./chat.interface";
import {
  assertWritable,
  audienceOf,
  canAccess,
  channelTitle,
  ensureChannels,
  isAdmin,
  isExternal,
  isStaff,
  loadChannel,
  loadChatUser,
  messageSelect,
  notFound,
  pushChatUnread,
  requireChannel,
  shapeMessage,
  shapePerson,
  unreadSql,
} from "./chat.shared";
import { channelRows, listProjects, visibility } from "./chat.list";
import { pushChatList } from "./chat.live";
import { presenceOf, stopTyping, dropUserFromChannel } from "./chat.presence";

// Project chat (real time). REST is the write path: it saves, then pushes what was saved to
// everyone in the channel over Socket.IO (see lib/realtime.ts). A push is only ever a convenience:
// the saved message is the truth.

const paged = (rows: any[], total: number, page: number, limit: number) => {
  const totalPage = Math.ceil(total / limit);
  return {
    data: rows,
    meta: {
      page,
      limit,
      total,
      totalPage,
      hasNextPage: page < totalPage,
      hasPrevPage: page > 1,
    },
  };
};

// My projects with their chats, most recent activity first
const getProjects = async (userId: string, params: Record<string, any>) =>
  listProjects(await loadChatUser(userId), params);

// The channels of one project that I may see
const getProjectChannels = async (userId: string, projectId: string) => {
  assertUuid(projectId, "project id");
  const user = await loadChatUser(userId);
  const project = await query(
    `SELECT id, number, title, relation_id FROM projects WHERE id = $1::uuid`,
    [projectId],
  );
  if (project.rows.length === 0)
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  await ensureChannels(projectId);
  const channels = (await channelRows(user, [projectId])).map(
    ({ project_id, ...c }: any) => c,
  );
  // Someone with no channel on this project does not learn that the project exists
  if (channels.length === 0)
    throw new ApiError(httpStatus.NOT_FOUND, "Project not found!");
  return {
    project: {
      id: project.rows[0].id,
      number: project.rows[0].number,
      title: project.rows[0].title,
    },
    channels,
  };
};

// The red dot for the chat menu: unread messages over all my channels
const getUnreadSummary = async (userId: string) => {
  const user = await loadChatUser(userId);
  const r = await query(
    `SELECT COALESCE(SUM(x.unread), 0)::int AS unread, COUNT(*) FILTER (WHERE x.unread > 0)::int AS channels_with_unread
     FROM (SELECT ${unreadSql("c.id", "$1")} AS unread FROM chat_channels c JOIN projects p ON p.id = c.project_id WHERE ${visibility(user)}) x`,
    [user.id, user.relation_id],
  );
  return r.rows[0];
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const encodeCursor = (ts: string, id: string) =>
  Buffer.from(`${ts}|${id}`).toString("base64url");
const decodeCursor = (cursor: string) => {
  const [ts, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (
    !ts ||
    !id ||
    Number.isNaN(Date.parse(ts)) ||
    !/^[0-9a-f-]{36}$/.test(id)
  ) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Invalid cursor!");
  }
  return { ts, id };
};

const tsText = `to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// Newest page by default; `before` (the `next_cursor` of the previous page) goes further back. The
// messages of a page come oldest first, ready to show.
// Who has read each message (read receipts). A person has read a message when they marked the channel read
// after it was sent, so this comes from `chat_reads`. The author never counts as a reader of their own message.
const withReceipts = async (channelId: string, rows: any[], viewer: { id: string; external: boolean }) => {
  const readers = await query(
    `SELECT r.user_id, u.name, u.role::text AS role, r.last_read_at
     FROM chat_reads r JOIN users u ON u.id = r.user_id
     WHERE r.channel_id = $1::uuid AND r.last_read_at IS NOT NULL ORDER BY r.last_read_at ASC`,
    [channelId],
  );
  return rows.map((row: any) => {
    const message = shapeMessage(row, viewer);
    if (message.deleted) return message;
    const created = +new Date(row.createdAt);
    message.read_by = readers.rows
      .filter((r: any) => r.user_id !== row.author_id && +new Date(r.last_read_at) >= created)
      .map((r: any) => ({ ...shapePerson({ id: r.user_id, name: r.name, role: r.role }, viewer.external), read_at: r.last_read_at }));
    return message;
  });
};

const getMessages = async (
  userId: string,
  channelId: string,
  params: Record<string, any>,
) => {
  const user = await loadChatUser(userId);
  const channel = await requireChannel(user, channelId);
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 100);

  const values: any[] = [channel.id];
  let cursor = "";
  if (params.before) {
    const c = decodeCursor(String(params.before));
    values.push(c.ts, c.id);
    cursor = ` AND (m.created_at, m.id) < ($2::timestamptz, $3::uuid)`;
  }
  const rows = await query(
    `SELECT ${messageSelect}, ${tsText} AS cursor_ts FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
     WHERE m.channel_id = $1::uuid${cursor} ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit + 1}`,
    values,
  );
  const more = rows.rows.length > limit;
  const page = rows.rows.slice(0, limit);
  const viewer = { id: user.id, external: isExternal(user.role) };
  const last = page[page.length - 1];
  return {
    data: await withReceipts(channel.id, page.reverse(), viewer),
    meta: {
      limit,
      has_more: more,
      next_cursor: more && last ? encodeCursor(last.cursor_ts, last.id) : null,
    },
    channel: {
      id: channel.id,
      kind: channel.kind,
      label: channelLabels[channel.kind],
      read_only: channel.read_only,
      project: {
        id: channel.project_id,
        number: channel.project_number,
        title: channel.project_title,
      },
    },
  };
};

const readMessage = async (
  id: string,
  viewer: { id: string; external: boolean },
) => {
  const r = await query(
    `SELECT ${messageSelect} FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = $1::uuid`,
    [id],
  );
  return r.rows[0] ? shapeMessage(r.rows[0], viewer) : null;
};

// Everything that happens after a message is saved. It never throws: the message is already safe.
const afterSend = async (
  channel: IChatChannel,
  messageId: string,
  actor: IChatUser,
  bodyText: string,
  hasFiles: boolean,
) => {
  try {
    const audience = await audienceOf(channel);
    const row = (
      await query(
        `SELECT ${messageSelect} FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = $1::uuid`,
        [messageId],
      )
    ).rows[0];

    // 1. Live: every person in the channel (the sender's other tabs too; the app recognises its own message by id)
    for (const person of audience) {
      const viewer = { id: person.id, external: isExternal(person.role) };
      emitToUser(person.id, "chat:message", {
        channel_id: channel.id,
        project_id: channel.project_id,
        message: shapeMessage(row, viewer),
      });
      if (person.id !== actor.id) await pushChatUnread(channel, person.id);
    }
    // Sending ends the sender's "typing"
    await stopTyping(actor.id, channel.id);
    // The chat list of every person in the channel (last message, unread, order)
    await pushChatList(audience.map((a) => a.id), channel.project_id);

    // 2. Employees: one in-app notification per channel until they read it (not one per message)
    const staffIds = audience
      .filter((a) => a.source === "staff")
      .map((a) => a.id);
    const crewIds = audience
      .filter((a) => a.source === "planned" || a.source === "added")
      .map((a) => a.id);
    const recipients = new Set<string>(crewIds);
    const manager =
      channel.project_manager_id &&
      staffIds.includes(channel.project_manager_id)
        ? channel.project_manager_id
        : null;
    if (manager) recipients.add(manager);
    else if (!isStaff(actor.role)) staffIds.forEach((id) => recipients.add(id));
    recipients.delete(actor.id);
    if (recipients.size > 0) {
      const already = await query(
        `SELECT user_id FROM notifications WHERE type = 'CHAT_MESSAGE' AND read_at IS NULL AND user_id = ANY($1::uuid[]) AND data->>'channel_id' = $2`,
        [[...recipients], channel.id],
      );
      const skip = new Set(already.rows.map((r: any) => r.user_id));
      const fresh = [...recipients].filter((id) => !skip.has(id));
      if (fresh.length > 0) {
        await notify(fresh, {
          type: "CHAT_MESSAGE",
          title: `${actor.name} wrote in ${channelTitle(channel)}`,
          body: bodyText || (hasFiles ? "Sent a file" : null),
          entity: { type: "project", id: channel.project_id },
          data: { channel_id: channel.id, message_id: messageId },
          actorId: actor.id,
        });
      }
    }

    // 3. Customers and subcontractors: an email, but at most one per channel every few minutes
    const preview = bodyText
      ? bodyText.length > 500
        ? `${bodyText.slice(0, 499)}…`
        : bodyText
      : "(a file)";
    for (const person of audience.filter(
      (a) =>
        (a.source === "customer" || a.source === "subcontractor") &&
        a.id !== actor.id,
    )) {
      const claimed = await query(
        `INSERT INTO chat_reads (channel_id, user_id, last_emailed_at) VALUES ($1::uuid, $2::uuid, CURRENT_TIMESTAMP)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET last_emailed_at = CURRENT_TIMESTAMP
         WHERE chat_reads.last_emailed_at IS NULL OR chat_reads.last_emailed_at < CURRENT_TIMESTAMP - make_interval(mins => ${EMAIL_EVERY_MINUTES})
         RETURNING 1`,
        [channel.id, person.id],
      );
      if (claimed.rows.length === 0) continue;
      const u = (
        await query(
          `SELECT email, preferred_language::text AS preferred_language FROM users WHERE id = $1::uuid`,
          [person.id],
        )
      ).rows[0];
      sendTemplatedEmail({
        to: u.email,
        templateKey: "portal_message",
        language: toLanguage(u.preferred_language),
        variables: {
          name: person.name,
          project: `${channel.project_number} ${channel.project_title}`,
          message: preview,
          link: `${config.frontend_url}/portal/projects/${channel.project_id}/chat`,
        },
        related: { type: "project", id: channel.project_id },
      }).catch(() => undefined);
    }
  } catch (error: any) {
    console.error("❌ Chat follow-up failed:", error?.message ?? error);
  }
};

const sendMessage = async (
  userId: string,
  channelId: string,
  input: { body?: string; client_id?: string },
  files: any[],
) => {
  const user = await loadChatUser(userId);
  const channel = await requireChannel(user, channelId);
  assertWritable(channel);

  const body = (input.body ?? "").trim();
  const fileList = files ?? [];
  if (!body && fileList.length === 0)
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Write a message or attach a file!",
    );
  if (body.length > MAX_BODY_LENGTH)
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `A message can be at most ${MAX_BODY_LENGTH} characters!`,
    );
  if (fileList.length > MAX_FILES_PER_MESSAGE)
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `At most ${MAX_FILES_PER_MESSAGE} files per message!`,
    );

  const viewer = { id: user.id, external: isExternal(user.role) };
  const inserted = await query(
    `INSERT INTO chat_messages (channel_id, author_id, body, client_id) VALUES ($1::uuid, $2::uuid, $3, $4)
     ON CONFLICT (author_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING id`,
    [channel.id, user.id, body, input.client_id ?? null],
  );
  if (inserted.rows.length === 0) {
    // The same message again (a retry): the first one stands
    const first = await query(
      `SELECT id FROM chat_messages WHERE author_id = $1::uuid AND client_id = $2`,
      [user.id, input.client_id],
    );
    return {
      message: await readMessage(first.rows[0].id, viewer),
      duplicate: true,
    };
  }
  const messageId = inserted.rows[0].id as string;

  if (fileList.length > 0) {
    try {
      // Same checks as every project file (real type from the bytes, 10 MB). Never "shared": only this channel sees it.
      await ProjectService.addFiles(
        channel.project_id,
        fileList,
        { folder: "GENERAL" },
        user.id,
        { chatMessageId: messageId },
      );
    } catch (error) {
      // No message is left behind without the files it was sent with
      await query(`DELETE FROM chat_messages WHERE id = $1::uuid`, [messageId]);
      throw error;
    }
  }

  const message = await readMessage(messageId, viewer);
  await afterSend(channel, messageId, user, body, fileList.length > 0);
  return { message, duplicate: false };
};

const loadOwnMessage = async (user: IChatUser, messageId: string) => {
  assertUuid(messageId, "message id");
  const found = await query(
    `SELECT id, channel_id, author_id, deleted_at, created_at FROM chat_messages WHERE id = $1::uuid`,
    [messageId],
  );
  if (found.rows.length === 0) throw notFound();
  const message = found.rows[0];
  const channel = await requireChannel(user, message.channel_id);
  return { message, channel };
};

// The author can correct a message for a few minutes
const editMessage = async (userId: string, messageId: string, body: string) => {
  const user = await loadChatUser(userId);
  const { message, channel } = await loadOwnMessage(user, messageId);
  assertWritable(channel);
  if (message.author_id !== user.id)
    throw new ApiError(
      httpStatus.FORBIDDEN,
      "You can only edit your own messages!",
    );
  if (message.deleted_at)
    throw new ApiError(httpStatus.CONFLICT, "This message was deleted!");
  const updated = await query(
    `UPDATE chat_messages SET body = $2, edited_at = CURRENT_TIMESTAMP
     WHERE id = $1::uuid AND created_at > CURRENT_TIMESTAMP - make_interval(mins => ${EDIT_WINDOW_MINUTES}) RETURNING id`,
    [messageId, body.trim()],
  );
  if (updated.rows.length === 0)
    throw new ApiError(
      httpStatus.CONFLICT,
      `A message can only be edited for ${EDIT_WINDOW_MINUTES} minutes!`,
    );

  const row = (
    await query(
      `SELECT ${messageSelect} FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = $1::uuid`,
      [messageId],
    )
  ).rows[0];
  for (const person of await audienceOf(channel)) {
    emitToUser(person.id, "chat:message_edited", {
      channel_id: channel.id,
      message: shapeMessage(row, {
        id: person.id,
        external: isExternal(person.role),
      }),
    });
  }
  // an edited last message changes the preview in the list
  await pushChatList((await audienceOf(channel)).map((a) => a.id), channel.project_id);
  return shapeMessage(row, { id: user.id, external: isExternal(user.role) });
};

// A deleted message disappears for everyone but stays in the database (the chat is a project record)
const deleteMessage = async (userId: string, messageId: string) => {
  const user = await loadChatUser(userId);
  const { message, channel } = await loadOwnMessage(user, messageId);
  if (message.author_id !== user.id && !isAdmin(user.role))
    throw new ApiError(
      httpStatus.FORBIDDEN,
      "You can only delete your own messages!",
    );
  if (message.deleted_at) return { id: messageId, deleted: true };
  await query(
    `UPDATE chat_messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1::uuid AND deleted_at IS NULL`,
    [messageId],
  );
  for (const person of await audienceOf(channel)) {
    emitToUser(person.id, "chat:message_deleted", {
      channel_id: channel.id,
      message_id: messageId,
    });
    await pushChatUnread(channel, person.id);
  }
  await pushChatList((await audienceOf(channel)).map((a) => a.id), channel.project_id);
  return { id: messageId, deleted: true };
};

// Read receipt, live: everyone in the channel learns that this person has now read it (up to `read_at`).
// The reader's own tabs hear nothing (they get chat:unread). Never throws: the read mark is already saved.
const pushReadReceipt = async (channel: IChatChannel, reader: IChatUser, readAt: Date) => {
  try {
    for (const person of await audienceOf(channel)) {
      if (person.id === reader.id) continue;
      emitToUser(person.id, "chat:read", {
        channel_id: channel.id,
        project_id: channel.project_id,
        reader: shapePerson({ id: reader.id, name: reader.name, role: reader.role }, isExternal(person.role)),
        read_at: new Date(readAt).toISOString(),
      });
    }
  } catch {
    // a push is a convenience
  }
};

// "I have read this channel": clears its unread count and its notification
const markRead = async (userId: string, channelId: string) => {
  const user = await loadChatUser(userId);
  const channel = await requireChannel(user, channelId);
  const marked = await query(
    `INSERT INTO chat_reads (channel_id, user_id, last_read_at) VALUES ($1::uuid, $2::uuid, CURRENT_TIMESTAMP)
     ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = CURRENT_TIMESTAMP RETURNING last_read_at`,
    [channel.id, user.id],
  );
  const cleared = await query(
    `UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = $1::uuid AND type = 'CHAT_MESSAGE' AND read_at IS NULL AND data->>'channel_id' = $2 RETURNING id`,
    [user.id, channel.id],
  );
  if (cleared.rows.length > 0) await pushUnreadCount(user.id, { read: cleared.rows.map((r: any) => r.id) });
  await pushChatUnread(channel, user.id);
  await pushChatList([user.id], channel.project_id);
  await pushReadReceipt(channel, user, marked.rows[0].last_read_at);
  return { channel_id: channel.id, unread: 0 };
};

// ---------------------------------------------------------------------------
// Members (office and admin)
// ---------------------------------------------------------------------------

const requireStaff = async (userId: string) => {
  const user = await loadChatUser(userId);
  if (!isStaff(user.role)) throw notFound();
  return user;
};

const getMembers = async (userId: string, channelId: string) => {
  await requireStaff(userId);
  const channel = await loadChannel(channelId);
  return (await audienceOf(channel)).map(({ id, name, role, source }) => ({
    id,
    name,
    role,
    source,
  }));
};

// Crew can be added to the customer channel (they are in the internal channel through the planning), or to the internal channel
const addMember = async (
  userId: string,
  channelId: string,
  memberId: string,
) => {
  const actor = await requireStaff(userId);
  const channel = await loadChannel(channelId);
  if (channel.kind === "SUBCONTRACTOR")
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "A subcontractor channel is for that company and the office only!",
    );
  const person = await query(
    `SELECT id, role::text AS role, is_active, status::text AS status FROM users WHERE id = $1::uuid`,
    [memberId],
  );
  if (
    person.rows.length === 0 ||
    person.rows[0].role !== "FIELD" ||
    !person.rows[0].is_active ||
    person.rows[0].status !== "ACTIVE"
  ) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Only an active field crew member can be added!",
    );
  }
  await query(
    `INSERT INTO chat_members (channel_id, user_id, added_by) VALUES ($1::uuid, $2::uuid, $3::uuid) ON CONFLICT DO NOTHING`,
    [channel.id, memberId, actor.id],
  );
  emitToUser(memberId, "chat:channels_changed", {
    project_id: channel.project_id,
  });
  await pushChatList([memberId], channel.project_id);
  return getMembers(userId, channelId);
};

// Takes back what was added by hand. Crew who are in the internal channel through the planning stay while they are planned.
const removeMember = async (
  userId: string,
  channelId: string,
  memberId: string,
) => {
  await requireStaff(userId);
  const channel = await loadChannel(channelId);
  assertUuid(memberId, "user id");
  const removed = await query(
    `DELETE FROM chat_members WHERE channel_id = $1::uuid AND user_id = $2::uuid RETURNING user_id`,
    [channel.id, memberId],
  );
  if (removed.rows.length === 0)
    throw new ApiError(
      httpStatus.NOT_FOUND,
      "This person was not added by hand!",
    );
  emitToUser(memberId, "chat:channels_changed", {
    project_id: channel.project_id,
  });
  await pushChatList([memberId], channel.project_id);
  // they may no longer watch the channel for typing and presence (unless the planning still gives it to them)
  const stillAllowed = await loadChatUser(memberId).then((u) => canAccess(u, channel)).catch(() => false);
  if (!stillAllowed) await dropUserFromChannel(memberId, channel.id);
  return getMembers(userId, channelId);
};

// Who is online in a channel I may see
const getPresence = async (userId: string, channelId: string) => {
  const user = await loadChatUser(userId);
  const channel = await requireChannel(user, channelId);
  return presenceOf(channel, user);
};

export const ChatService = {
  getProjects,
  getProjectChannels,
  getUnreadSummary,
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  markRead,
  getMembers,
  getPresence,
  addMember,
  removeMember,
};
