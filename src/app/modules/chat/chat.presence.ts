import { emitToUser, IFrameContext, isConnected, registerFrameHandler, registerRealtimeHooks } from "../../lib/realtime";
import { IChatChannel } from "./chat.interface";
import { audienceOf, canAccess, isExternal, loadChannel, loadChatUser, shapePerson } from "./chat.shared";

// Typing indicators and who is online, for the people who are LOOKING at a channel.
//
// A client says which channel it has open:      { event: "chat:open",   data: { channel_id } }
// and when it stops looking:                    { event: "chat:close",  data: { channel_id } }
// and, while the person types:                  { event: "chat:typing", data: { channel_id, typing: true|false } }
//
// The server answers `chat:open` with  chat:presence { channel_id, online: [...], count }  and then pushes to
// everyone who has the same channel open (never to the others, never to people who lost access):
//   chat:typing    { channel_id, project_id, user, typing }
//   chat:presence  { channel_id, online, count }       whenever a member of the channel comes online or goes offline
// "Online" means the person has at least one open connection (any tab). Nobody can open a channel they may not
// see: it answers `error` { message: "Chat not found!", channel_id } like REST answers 404.
// Typing stops by itself after a few seconds, when the person sends the message, closes the channel, loses access
// or disconnects. Customers and subcontractors see first names and a role label, and no user ids, as in messages.

const MAX_OPEN_CHANNELS = 10;
const TYPING_TTL_MS = 6000;
// Access is checked when a channel is opened and again if it was longer ago than this
const REVERIFY_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ISubscription {
  userId: string;
  projectId: string;
  verifiedAt: number;
}

// channel -> connection -> subscription, and connection -> its open channels
const watchers = new Map<string, Map<number, ISubscription>>();
const opened = new Map<number, Set<string>>();
// channel -> person -> the timer that ends their "typing"
// (and which connection it came from: when that tab closes, the typing ends with it)
const typing = new Map<string, Map<string, { timer: NodeJS.Timeout; connectionId: number }>>();

const watcherIds = (channelId: string) => [...new Set([...(watchers.get(channelId)?.values() ?? [])].map((s) => s.userId))];
const isWatching = (userId: string, channelId: string) => watcherIds(channelId).includes(userId);

// ---------------------------------------------------------------------------
// Who is online
// ---------------------------------------------------------------------------

// The online members of a channel, as one viewer should see them
const onlineFor = (audience: Awaited<ReturnType<typeof audienceOf>>, viewer: { id: string; role: string }) => {
  const people = audience
    .filter((a) => isConnected(a.id))
    .map((a) => ({ ...shapePerson(a, isExternal(viewer.role)), is_me: a.id === viewer.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { online: people, count: people.length };
};

// Tells everyone who has the channel open who is online now
const pushPresence = async (channel: IChatChannel) => {
  const watching = watcherIds(channel.id);
  if (watching.length === 0) return;
  const audience = await audienceOf(channel);
  for (const person of audience) {
    if (!watching.includes(person.id)) continue;
    emitToUser(person.id, "chat:presence", { channel_id: channel.id, ...onlineFor(audience, person) });
  }
};

// ---------------------------------------------------------------------------
// Open and close
// ---------------------------------------------------------------------------

const fail = (ctx: IFrameContext, channelId: unknown, message = "Chat not found!") => ctx.reply("error", { message, channel_id: typeof channelId === "string" ? channelId : null });

const addWatcher = (ctx: IFrameContext, channel: IChatChannel) => {
  const map = watchers.get(channel.id) ?? new Map<number, ISubscription>();
  map.set(ctx.connectionId, { userId: ctx.userId, projectId: channel.project_id, verifiedAt: Date.now() });
  watchers.set(channel.id, map);
  const mine = opened.get(ctx.connectionId) ?? new Set<string>();
  mine.add(channel.id);
  opened.set(ctx.connectionId, mine);
};

const removeWatcher = (connectionId: number, channelId: string) => {
  const map = watchers.get(channelId);
  map?.delete(connectionId);
  if (map && map.size === 0) watchers.delete(channelId);
  const mine = opened.get(connectionId);
  mine?.delete(channelId);
  if (mine && mine.size === 0) opened.delete(connectionId);
};

const openChannel = async (ctx: IFrameContext, data: any) => {
  const channelId = data?.channel_id;
  if (typeof channelId !== "string" || !UUID.test(channelId)) return fail(ctx, channelId);
  const user = await loadChatUser(ctx.userId).catch(() => null);
  const channel = user ? await loadChannel(channelId).catch(() => null) : null;
  if (!user || !channel || !(await canAccess(user, channel))) return fail(ctx, channelId);

  const already = opened.get(ctx.connectionId);
  if (!already?.has(channelId) && (already?.size ?? 0) >= MAX_OPEN_CHANNELS) {
    return fail(ctx, channelId, `At most ${MAX_OPEN_CHANNELS} chats can be open at once!`);
  }
  addWatcher(ctx, channel);
  // The opener gets the list of who is online right away (to this connection only)
  const audience = await audienceOf(channel);
  ctx.reply("chat:presence", { channel_id: channel.id, ...onlineFor(audience, user) });
};

const closeChannel = async (ctx: IFrameContext, data: any) => {
  const channelId = data?.channel_id;
  if (typeof channelId !== "string" || !UUID.test(channelId)) return;
  removeWatcher(ctx.connectionId, channelId);
  const typingFromHere = typing.get(channelId)?.get(ctx.userId)?.connectionId === ctx.connectionId;
  if (typingFromHere || !isWatching(ctx.userId, channelId)) await stopTyping(ctx.userId, channelId);
};

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

const broadcastTyping = async (channelId: string, userId: string, isTyping: boolean) => {
  const channel = await loadChannel(channelId).catch(() => null);
  if (!channel) return;
  const watching = watcherIds(channelId).filter((id) => id !== userId);
  if (watching.length === 0) return;
  const audience = await audienceOf(channel);
  // someone who just lost access (and so is no longer in the audience) is still shown stopping
  const typist =
    audience.find((a) => a.id === userId) ??
    (await loadChatUser(userId).then((u) => ({ id: u.id, name: u.name, role: u.role })).catch(() => null));
  if (!typist) return;
  for (const person of audience) {
    if (!watching.includes(person.id)) continue;
    emitToUser(person.id, "chat:typing", {
      channel_id: channelId,
      project_id: channel.project_id,
      user: shapePerson(typist, isExternal(person.role)),
      typing: isTyping,
    });
  }
};

// Ends the person's "typing" in the channel (if it was on) and tells the others
export const stopTyping = async (userId: string, channelId: string) => {
  const timers = typing.get(channelId);
  const entry = timers?.get(userId);
  if (!timers || !entry) return;
  clearTimeout(entry.timer);
  timers.delete(userId);
  if (timers.size === 0) typing.delete(channelId);
  await broadcastTyping(channelId, userId, false).catch(() => undefined);
};

const handleTyping = async (ctx: IFrameContext, data: any) => {
  const channelId = data?.channel_id;
  if (typeof channelId !== "string" || !UUID.test(channelId) || typeof data?.typing !== "boolean") return;

  const sub = watchers.get(channelId)?.get(ctx.connectionId);
  if (!sub) return; // only a channel the person has open (and was allowed to open)

  if (!data.typing) return void (await stopTyping(ctx.userId, channelId));

  // Access can end while a channel stays open (crew taken off the project): check again now and then
  if (Date.now() - sub.verifiedAt > REVERIFY_MS) {
    const user = await loadChatUser(ctx.userId).catch(() => null);
    const channel = user ? await loadChannel(channelId).catch(() => null) : null;
    if (!user || !channel || !(await canAccess(user, channel))) return void removeWatcher(ctx.connectionId, channelId);
    sub.verifiedAt = Date.now();
  }

  const timers = typing.get(channelId) ?? new Map<string, { timer: NodeJS.Timeout; connectionId: number }>();
  typing.set(channelId, timers);
  const wasTyping = timers.has(ctx.userId);
  if (wasTyping) clearTimeout(timers.get(ctx.userId)!.timer);
  const timer = setTimeout(() => void stopTyping(ctx.userId, channelId), TYPING_TTL_MS);
  timer.unref();
  timers.set(ctx.userId, { timer, connectionId: ctx.connectionId });
  // Only the start is announced: keep-alive frames just move the timer
  if (!wasTyping) await broadcastTyping(channelId, ctx.userId, true);
};

// ---------------------------------------------------------------------------
// Connections coming and going, and access ending
// ---------------------------------------------------------------------------

// A tab closed: it no longer watches anything; if the person watches nothing else, their typing ends
const onConnectionClosed = async (userId: string, connectionId: number) => {
  const mine = [...(opened.get(connectionId) ?? [])];
  for (const channelId of mine) {
    removeWatcher(connectionId, channelId);
    // the tab they were typing in is gone, or they watch this channel nowhere else any more
    const typingFromHere = typing.get(channelId)?.get(userId)?.connectionId === connectionId;
    if (typingFromHere || !isWatching(userId, channelId)) await stopTyping(userId, channelId);
  }
};

// Someone came online or went offline: the channels that are open and that they belong to get the new list
const onPresenceChange = async (userId: string) => {
  for (const channelId of [...watchers.keys()]) {
    const channel = await loadChannel(channelId).catch(() => null);
    if (!channel) continue;
    if ((await audienceOf(channel)).some((a) => a.id === userId)) await pushPresence(channel);
  }
};

// A person lost access to the channel (removed by hand): they stop watching it at once
export const dropUserFromChannel = async (userId: string, channelId: string) => {
  for (const [connectionId, sub] of [...(watchers.get(channelId) ?? [])]) {
    if (sub.userId === userId) removeWatcher(connectionId, channelId);
  }
  await stopTyping(userId, channelId);
};

// A person's list no longer has the project (planning took them off it): they stop watching its channels
export const dropUserFromProject = async (userId: string, projectId: string) => {
  for (const [channelId, map] of [...watchers]) {
    if ([...map.values()].some((s) => s.userId === userId && s.projectId === projectId)) await dropUserFromChannel(userId, channelId);
  }
};

registerFrameHandler("chat:open", openChannel);
registerFrameHandler("chat:close", closeChannel);
registerFrameHandler("chat:typing", handleTyping);
registerRealtimeHooks({
  onConnectionClosed,
  onUserOnline: onPresenceChange,
  onUserOffline: onPresenceChange,
});

// The people who are online in a channel, for `GET /chat/channels/:id/presence`
export const presenceOf = async (channel: IChatChannel, viewer: { id: string; role: string }) => onlineFor(await audienceOf(channel), viewer);
