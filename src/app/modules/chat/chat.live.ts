import { connectedUserIds, emitToUser, isConnected, registerRealtimeHooks } from "../../lib/realtime";
import { query } from "../../utils/db";
import { listProjects, projectListItems } from "./chat.list";
import { dropUserFromProject } from "./chat.presence";
import { audienceOf, loadChannel, loadChatUser } from "./chat.shared";

// The chat list, live. Two events, both built by the same code as `GET /chat/projects`:
//   chat:projects  { projects, meta }          the person's WHOLE chat list (first page, 50 projects), the project
//                                              with the newest message first. Sent when they log in and after every
//                                              change, so the app can simply show it.
//   chat:list      { project_id, item }        just the one project that changed (cheap to apply); `item: null` means
//                                              "this project is not in your list" (you lost access), safe to apply twice.
// Nothing here ever throws: the change itself is already saved.

const LIST_PAGE_SIZE = 50;

type TReply = (event: string, data?: Record<string, any>) => void;

// The whole list of one person (to a single connection after login, or to all their tabs)
export const pushChatProjects = async (userId: string, reply?: TReply) => {
  try {
    const user = await loadChatUser(userId).catch(() => null);
    if (!user) return;
    const list = await listProjects(user, { page: 1, limit: LIST_PAGE_SIZE });
    const payload = { projects: list.data, meta: list.meta };
    if (reply) reply("chat:projects", payload);
    else emitToUser(userId, "chat:projects", payload);
  } catch (error: any) {
    console.error("❌ Could not push the chat list:", error?.message ?? error);
  }
};

export const pushChatList = async (userIds: string[], projectId: string) => {
  try {
    for (const id of new Set(userIds)) {
      if (!isConnected(id)) continue; // nobody to tell: no work
      const user = await loadChatUser(id).catch(() => null);
      if (!user) continue;
      const [item] = await projectListItems(user, [projectId]);
      emitToUser(id, "chat:list", { project_id: projectId, item: item ?? null });
      // a project that left their list also ends their typing and presence in its channels
      if (!item) await dropUserFromProject(id, projectId);
      await pushChatProjects(id);
    }
  } catch (error: any) {
    console.error("❌ Could not push the chat list:", error?.message ?? error);
  }
};

// Everyone who logs in gets their whole chat list straight away
registerRealtimeHooks({ onLogin: (userId, reply) => pushChatProjects(userId, reply) });

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
