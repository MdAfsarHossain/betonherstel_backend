import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import { listConversations } from "./chat.conversations.list";
import { listProjects, projectListItems } from "./chat.list";
import { IChatUser } from "./chat.interface";
import { ensureChannels, isEmployee, notFound } from "./chat.shared";
import { conversationItems } from "./chat.conversations.list";
import assertUuid from "../../utils/assertUuid";
import { query } from "../../utils/db";

// ONE chat list for a person: project chats (type "project"), one-to-one staff chats (type "single") and group
// staff chats (type "group"), the one with the newest message first. Used by `GET /chat/list` and by the live
// `chat:chats` push, so the order is always the server's. Customers and subcontractors only get project chats.
//
// Both sources are already sorted by (last message, created) newest first, so the first `skip + limit` entries of
// each are enough to find the exact page of the merge.

export const chatTypes = ["project", "single", "group"] as const;

const time = (value: any) => (value ? +new Date(value) : -Infinity);

// Newest activity first: the last message, or the creation of a chat nobody has written in yet. A chat that was
// just created is therefore on top, and an older chat comes back to the top when someone writes in it.
const newestFirst = (a: any, b: any) => time(b.activity_at) - time(a.activity_at) || String(a.id).localeCompare(String(b.id));

export const listChats = async (user: IChatUser, params: Record<string, any>) => {
  const type = params.type === undefined || params.type === "" ? null : String(params.type);
  if (type !== null && !(chatTypes as readonly string[]).includes(type)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "type should be project, single or group!");
  }
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const window = { limit: skip + limit, skip: 0 };

  const wantProjects = type === null || type === "project";
  const wantStaffChats = isEmployee(user.role) && (type === null || type === "single" || type === "group");
  const empty = { data: [] as any[], meta: { total: 0 } };
  const [projects, conversations] = await Promise.all([
    wantProjects ? listProjects(user, params, window) : empty,
    wantStaffChats ? listConversations(user, params, window) : empty,
  ]);

  const total = projects.meta.total + conversations.meta.total;
  const totalPage = Math.ceil(total / limit);
  return {
    data: [...projects.data, ...conversations.data].sort(newestFirst).slice(skip, skip + limit),
    meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 },
  };
};

// "Open this chat": the entry of ONE chat, the same shape as an entry of the list, whatever its type.
//   project        `id` = the project id. `channels[]` are the project's chats I may see (CUSTOMER / INTERNAL /
//                  SUBCONTRACTOR); read and write each one through its channel id.
//   single/group   `id` = the conversation id, which is also its channel id. `participants[]` are its members.
// Not found, not yours and the wrong type all answer 404, so nobody learns that a chat exists.
export const getChat = async (user: IChatUser, type: string, id: string) => {
  if (!(chatTypes as readonly string[]).includes(type)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "type should be project, single or group!");
  }
  assertUuid(id, "chat id");

  if (type === "project") {
    const project = await query(`SELECT 1 FROM projects WHERE id = $1::uuid`, [id]);
    if (project.rows.length === 0) throw notFound();
    await ensureChannels(id);
    const [item] = await projectListItems(user, [id]);
    if (!item) throw notFound();
    return item;
  }

  if (!isEmployee(user.role)) throw notFound();
  const [item] = await conversationItems(user, [id]);
  if (!item || item.type !== type) throw notFound();
  return item;
};
