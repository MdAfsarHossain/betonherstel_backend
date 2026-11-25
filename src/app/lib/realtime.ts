import { IncomingMessage, Server as HttpServer } from "http";
import { Duplex } from "stream";
import { Secret } from "jsonwebtoken";
import { RawData, WebSocket, WebSocketServer } from "ws";
import config from "../../config";
import assertUserActive from "../helpers/assertUserActive";
import { jwtHelpers } from "../helpers/jwtHelpers";
import { query } from "../utils/db";

// Live updates over a native WebSocket (the `ws` package). The REST API stays the source of truth: the
// server only *pushes* what was just saved, so the web app can update without polling.
//
// Connect:  new WebSocket("wss://<server>/ws")
// Every frame, both ways, is JSON:  { "event": "<name>", "data": { ... } }
//
// 1. Log in. A browser cannot set headers on a WebSocket, so the first frame is
//        { "event": "auth", "data": { "token": "<access token>" } }
//    (non-browser clients may send `Authorization: Bearer <token>` on the upgrade instead). It must come
//    within AUTH_TIMEOUT_MS. The server answers { "event": "auth:ok", "data": { "employee": true|false } }
//    or { "event": "error", "data": { "message": "Unauthorized" } } and closes with code 4401.
// 2. Listen. Events are sent to one person only (never broadcast):
//      notification:new     { notification, unread_notifications }   a notification was just saved for you
//      notification:unread  { unread_notifications }                 your unread count changed (employees)
//      chat:message / chat:message_edited / chat:message_deleted / chat:unread / chat:channels_changed
//                                                                    the project chat (see modules/chat)
// 3. The client sends nothing else except { "event": "ping" } (answered with "pong"), because a browser
//    cannot send a protocol-level ping, and the few events a module registers with registerFrameHandler
//    (the chat: chat:open, chat:close, chat:typing). Every other frame is ignored, and a client that floods
//    is closed.
//
// A connection ends when its token expires and when an admin deactivates, blocks or demotes the account.
// Close codes: 4401 not logged in / token expired, 4403 account no longer allowed, 4429 too many frames,
// 1009 frame too large.

const WS_PATH = "/ws";
const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30_000;
const MAX_FRAME_BYTES = 10_000;
const MAX_CONNECTIONS_PER_USER = 10;
const FLOOD_FRAMES = 30;
const FLOOD_WINDOW_MS = 10_000;

// Notifications are for employees. Customers and subcontractors may connect too, but only for the
// project chat they are members of (chat events are sent per person, see chat.service.ts).
const employeeRoles = ["SUPERADMIN", "ADMIN", "OFFICE", "FIELD"];
const connectRoles = [...employeeRoles, "CUSTOMER", "SUBCONTRACTOR"];

let nextConnectionId = 1;

interface IClient extends WebSocket {
  connId?: number;
  userId?: string;
  employee?: boolean;
  isAlive?: boolean;
  authTimer?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
  frames?: { count: number; since: number };
  authenticating?: boolean;
}

// Open connections per person (a person can have several tabs)
const connections = new Map<string, Set<IClient>>();

export const unreadCountOf = async (userId: string) => {
  const result = await query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1::uuid AND read_at IS NULL`,
    [userId],
  );
  return result.rows[0].n as number;
};

// Other modules (the chat) can act on what happens to connections, without this file importing them
type TReply = (event: string, data?: Record<string, any>) => void;
export interface IFrameContext {
  userId: string;
  connectionId: number;
  reply: TReply;
}
let onLogin: ((userId: string, reply: TReply) => Promise<void> | void) | null = null;
let onUserOnline: ((userId: string) => Promise<void> | void) | null = null;
let onUserOffline: ((userId: string) => Promise<void> | void) | null = null;
let onConnectionClosed: ((userId: string, connectionId: number) => Promise<void> | void) | null = null;
export const registerRealtimeHooks = (hooks: {
  onLogin?: (userId: string, reply: TReply) => Promise<void> | void;
  // a person's first connection opened / their last one closed (several tabs count as one person)
  onUserOnline?: (userId: string) => Promise<void> | void;
  onUserOffline?: (userId: string) => Promise<void> | void;
  onConnectionClosed?: (userId: string, connectionId: number) => Promise<void> | void;
}) => {
  if (hooks.onLogin) onLogin = hooks.onLogin;
  if (hooks.onUserOnline) onUserOnline = hooks.onUserOnline;
  if (hooks.onUserOffline) onUserOffline = hooks.onUserOffline;
  if (hooks.onConnectionClosed) onConnectionClosed = hooks.onConnectionClosed;
};

// Events a client may send after logging in. Only what a module registers here is accepted; each handler
// does its own checks. A handler that throws is ignored: the client can never crash the server.
const frameHandlers = new Map<string, (ctx: IFrameContext, data: any) => Promise<void> | void>();
export const registerFrameHandler = (event: string, handler: (ctx: IFrameContext, data: any) => Promise<void> | void) => {
  frameHandlers.set(event, handler);
};

const safely = (fn: (() => Promise<void> | void) | null) => {
  if (!fn) return;
  Promise.resolve()
    .then(fn)
    .catch(() => undefined);
};

// Who is online right now: used so the server does not work out live updates for people who are not connected
export const isConnected = (userId: string) => (connections.get(userId)?.size ?? 0) > 0;
export const connectedUserIds = () => [...connections.keys()];

const send = (ws: WebSocket, event: string, data: Record<string, any> = {}) => {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ event, data }));
};

// Safe to call from anywhere: without a running WebSocket server (scripts, tests, a cron host that only
// serves HTTP) nobody is connected, so it does nothing, and it never throws.
export const emitToUser = (
  userId: string,
  event: string,
  data: Record<string, any>,
) => {
  try {
    const set = connections.get(userId);
    if (!set || set.size === 0) return;
    const frame = JSON.stringify({ event, data });
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  } catch {
    // a client that is gone: nothing to do
  }
};

// Used when an account is deactivated or loses its role: its open connections end at once
export const disconnectUser = (userId: string) => {
  try {
    for (const ws of [...(connections.get(userId) ?? [])])
      ws.close(4403, "Forbidden");
  } catch {
    // already closed
  }
};

const tokenFromHeader = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  return typeof header === "string" && /^Bearer\s+/i.test(header)
    ? header.replace(/^Bearer\s+/i, "").trim()
    : null;
};

const reject = (ws: IClient, message = "Unauthorized") => {
  send(ws, "error", { message });
  ws.close(4401, "Unauthorized");
};

// Same checks as a REST call: a valid access token and an active account
const authenticate = async (ws: IClient, rawToken: unknown) => {
  try {
    if (ws.userId || ws.authenticating) return; // already logged in, or being checked
    ws.authenticating = true;
    const token =
      typeof rawToken === "string"
        ? rawToken.replace(/^Bearer\s+/i, "").trim()
        : "";
    if (!token) return reject(ws);

    const payload = jwtHelpers.verifyToken(
      token,
      config.jwt.access_secret as Secret,
    );
    if (!payload?.id) return reject(ws);

    const found = await query(
      `SELECT id, role::text AS role, status::text AS status, is_active FROM users WHERE id = $1::uuid`,
      [payload.id],
    );
    const user = found.rows[0];
    if (!user) return reject(ws);
    assertUserActive(user);
    if (!connectRoles.includes(user.role)) return reject(ws);
    if (ws.readyState !== WebSocket.OPEN) return;

    clearTimeout(ws.authTimer);
    ws.userId = user.id;
    ws.employee = employeeRoles.includes(user.role);

    // A person with too many tabs open: the oldest connection goes
    const set = connections.get(user.id) ?? new Set<IClient>();
    if (set.size >= MAX_CONNECTIONS_PER_USER) {
      const oldest = set.values().next().value as IClient | undefined;
      oldest?.close(4403, "Too many connections");
    }
    const wasOnline = set.size > 0;
    ws.connId = nextConnectionId++;
    set.add(ws);
    connections.set(user.id, set);

    // A connection never outlives its token: the web app reconnects with a fresh one
    if (payload.exp) {
      ws.expiryTimer = setTimeout(
        () => ws.close(4401, "Token expired"),
        Math.max(0, payload.exp * 1000 - Date.now()),
      );
      ws.expiryTimer.unref();
    }

    send(ws, "auth:ok", { employee: ws.employee });
    if (ws.employee)
      send(ws, "notification:unread", {
        unread_notifications: await unreadCountOf(user.id),
      });
    // e.g. the chat sends this person's whole chat list now (to this connection only)
    if (onLogin) await Promise.resolve(onLogin(user.id, (event, data) => send(ws, event, data))).catch(() => undefined);
    // the person just came online (their first connection): e.g. the chat tells the people looking at a channel
    if (!wasOnline) safely(onUserOnline ? () => onUserOnline!(user.id) : null);
  } catch {
    reject(ws);
  }
};

const onFrame = (ws: IClient, raw: RawData) => {
  // Too many frames in a short time: closed (a real client sends almost nothing)
  const now = Date.now();
  if (!ws.frames || now - ws.frames.since > FLOOD_WINDOW_MS)
    ws.frames = { count: 0, since: now };
  if (++ws.frames.count > FLOOD_FRAMES)
    return ws.close(4429, "Too many messages");

  let message: any;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return; // not JSON: ignored
  }
  if (!message || typeof message !== "object") return;

  if (message.event === "auth")
    return void authenticate(ws, message.data?.token);
  if (!ws.userId) return; // nothing but logging in is accepted before that
  if (message.event === "ping") return send(ws, "pong");

  // Only events a module registered are accepted; anything else is ignored
  const handler = typeof message.event === "string" ? frameHandlers.get(message.event) : undefined;
  if (handler) {
    const ctx: IFrameContext = { userId: ws.userId, connectionId: ws.connId as number, reply: (event, data) => send(ws, event, data) };
    safely(() => handler(ctx, message.data));
  }
};

const onClose = (ws: IClient) => {
  clearTimeout(ws.authTimer);
  clearTimeout(ws.expiryTimer);
  if (ws.userId) {
    const userId = ws.userId;
    const set = connections.get(userId);
    set?.delete(ws);
    const gone = !!set && set.size === 0;
    if (gone) connections.delete(userId);
    safely(onConnectionClosed ? () => onConnectionClosed!(userId, ws.connId as number) : null);
    // the person's last connection closed: they are offline now
    if (gone) safely(onUserOffline ? () => onUserOffline!(userId) : null);
  }
};

export const attachRealtime = (
  httpServer: HttpServer,
  allowedOrigins: string[] | ((origin: string) => boolean),
) => {
  const isAllowed = (origin: string) =>
    typeof allowedOrigins === "function" ? allowedOrigins(origin) : allowedOrigins.includes(origin);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });

  // Only /ws, and only from the CRM's own sites (a script or tool that sends no Origin is let through to the login step)
  httpServer.on(
    "upgrade",
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? "").split("?")[0];
      const origin = req.headers.origin;
      if (path !== WS_PATH) {
        socket.destroy();
        return;
      }
      if (origin && !isAllowed(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req),
      );
    },
  );

  wss.on("connection", (client: WebSocket, req: IncomingMessage) => {
    const ws = client as IClient;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("message", (raw) => onFrame(ws, raw));
    ws.on("close", () => onClose(ws));
    ws.on("error", () => ws.terminate());

    // Log in with the upgrade's header, or send the auth frame in time
    const headerToken = tokenFromHeader(req);
    if (headerToken) void authenticate(ws, headerToken);
    else ws.authTimer = setTimeout(() => reject(ws), AUTH_TIMEOUT_MS);
  });

  // Connections that went silent (a closed laptop, a dropped network) are removed
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as IClient;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
};
