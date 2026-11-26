import { connectedUserIds, emitToUser, isConnected, registerRealtimeHooks } from "../../lib/realtime";
import { query } from "../../utils/db";
import { listChats } from "./chat.chats";
import { projectListItems } from "./chat.list";
import { conversationItems } from "./chat.conversations.list";
import { dropUserFromChannel, dropUserFromProject } from "./chat.presence";
import { IChatChannel } from "./chat.interface";
import { audienceOf, isEmployee, loadChannel, loadChatUser } from "./chat.shared";

// The chat list, live. ONE list for everything a person can chat in, and every entry has a `type`:
// "project" (a project's chats), "single" (a one-to-one staff chat) or "group" (a staff group). Two events, both
// built by the same code as `GET /chat/list`, so they can never differ from it:
//   chat:chats  { chats, meta }       the person's WHOLE chat list (first page, 50 entries), the entry with the
//                                     newest message first. Sent when they log in and after every change, so the
//                                     app can simply show it.
//   chat:chat   { type, id, item }    just the one entry that changed (cheap to apply). `id` is the project id for
//                                     "project" and the conversation id for "single" / "group". `item: null` means
//                                     "this is not in your list" (you lost access, left the group), safe to apply twice.
// Nothing here ever throws: the change itself is already saved.

const LIST_PAGE_SIZE = 50;

type TReply = (event: string, data?: Record<string, any>) => void;

// The whole list of one person (to a single connection after login, or to all their tabs)
export const pushChats = async (userId: string, reply?: TReply) => {
  try {
    const user = await loadChatUser(userId).catch(() => null);
    if (!user) return;
    const list = await listChats(user, { page: 1, limit: LIST_PAGE_SIZE });
    const payload = { chats: list.data, meta: list.meta };
    if (reply) reply("chat:chats", payload);
    else emitToUser(userId, "chat:chats", payload);
  } catch (error: any) {
    console.error("❌ Could not push the chat list:", error?.message ?? error);
  }
};

// One project's entry changed for these people
export const pushChatList = async (userIds: string[], projectId: string) => {
  try {
    for (const id of new Set(userIds)) {
      if (!isConnected(id)) continue; // nobody to tell: no work
      const user = await loadChatUser(id).catch(() => null);
      if (!user) continue;
      const [item] = await projectListItems(user, [projectId]);
      emitToUser(id, "chat:chat", { type: "project", id: projectId, item: item ?? null });
      // a project that left their list also ends their typing and presence in its channels
      if (!item) await dropUserFromProject(id, projectId);
      await pushChats(id);
    }
  } catch (error: any) {
    console.error("❌ Could not push the chat list:", error?.message ?? error);
  }
};

// One staff chat's entry changed for these people (employees only)
export const pushConversationList = async (userIds: string[], channelId: string) => {
  try {
    // the type is needed even when the entry is gone (`item: null`), so it comes from the channel itself
    const channel = await loadChannel(channelId).catch(() => null);
    const type = channel?.kind === "DIRECT" ? "single" : "group";
    for (const id of new Set(userIds)) {
      if (!isConnected(id)) continue; // nobody to tell: no work
      const user = await loadChatUser(id).catch(() => null);
      if (!user || !isEmployee(user.role)) continue;
      const [item] = await conversationItems(user, [channelId]);
      emitToUser(id, "chat:chat", { type, id: channelId, item: item ?? null });
      // a conversation that left their list also ends their typing and presence in it
      if (!item) await dropUserFromChannel(id, channelId);
      await pushChats(id);
    }
  } catch (error: any) {
    console.error("❌ Could not push the conversation list:", error?.message ?? error);
  }
};

// Tells the people in a channel that its list entry changed: the project's entry for a project channel,
// the staff chat's own entry for a staff chat
export const pushChannelList = (channel: Pick<IChatChannel, "id" | "project_id">, userIds: string[]) =>
  channel.project_id ? pushChatList(userIds, channel.project_id) : pushConversationList(userIds, channel.id);

// Everyone who logs in gets their whole chat list straight away
registerRealtimeHooks({ onLogin: (userId, reply) => pushChats(userId, reply) });

// Everyone who may see any channel of the project. With `includeCrewLoss`, field crew who are online
// are told too, because planning changes can take a project away from them.
export const announceProject = async (projectId: string | null | undefined, options: { includeCrewLoss?: boolean } = {}) => {
  if (!projectId) return;
  try {
    const ids = new Set<string>();
    const channels = await query(`SELECT id FROM chat_channels WHERE project_id = $1::uuid`, [projectId]);
    for (const row of channels.rows) {
      for (const person of await audienceOf(await loadChannel(row.id))) ids.add(person.id);
    }
    if (options.includeCrewLoss) {
      const online = connectedUserIds();
      if (online.length > 0) {
        const crew = await query(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND role::text = 'FIELD'`, [online]);
        crew.rows.forEach((r: any) => ids.add(r.id));
      }
    }
    await pushChatList([...ids], projectId);
  } catch (error: any) {
    console.error("❌ Could not announce the project chat:", error?.message ?? error);
  }
};
