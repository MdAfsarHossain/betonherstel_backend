import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { emitToUser } from "../../lib/realtime";
import assertUuid from "../../utils/assertUuid";
import { query } from "../../utils/db";
import {
  adminRoles, channelLabels, externalRoles, IChatChannel, IChatUser, READ_ONLY_AFTER_DAYS, roleLabels, staffRoles,
} from "./chat.interface";

// Who may see which channel, and the pieces every chat service shares. `canAccess` is THE rule:
// the REST API, the live push and the notifications all go through it, so they can never disagree.

export const isStaff = (role: string) => (staffRoles as readonly string[]).includes(role);
export const isAdmin = (role: string) => (adminRoles as readonly string[]).includes(role);
export const isExternal = (role: string) => (externalRoles as readonly string[]).includes(role);

export const loadChatUser = async (userId: string): Promise<IChatUser> => {
  const found = await query(`SELECT id, name, role::text AS role, relation_id FROM users WHERE id = $1::uuid`, [userId]);
  if (found.rows.length === 0) throw new ApiError(httpStatus.UNAUTHORIZED, "You are not authorized!");
  return found.rows[0];
};

const channelSelect = `
  SELECT c.id, c.project_id, c.kind, c.relation_id,
         p.number AS project_number, p.title AS project_title, p.relation_id AS customer_relation_id,
         p.project_manager_id,
         (p.closed_at IS NOT NULL AND p.closed_at < CURRENT_TIMESTAMP - make_interval(days => ${READ_ONLY_AFTER_DAYS})) AS read_only
  FROM chat_channels c JOIN projects p ON p.id = c.project_id
`;

export const notFound = () => new ApiError(httpStatus.NOT_FOUND, "Chat not found!");

export const loadChannel = async (channelId: string): Promise<IChatChannel> => {
  assertUuid(channelId, "channel id");
  const found = await query(`${channelSelect} WHERE c.id = $1::uuid`, [channelId]);
  if (found.rows.length === 0) throw notFound();
  return found.rows[0];
};

// Field crew who are planned on the project (an appointment or a work order)
const plannedCrewSql = `
  SELECT aa.user_id FROM appointment_assignees aa JOIN appointments a ON a.id = aa.appointment_id
  WHERE a.project_id = $1::uuid AND a.status <> 'CANCELLED'
  UNION
  SELECT wa.user_id FROM work_order_assignees wa JOIN work_orders w ON w.id = wa.work_order_id
  WHERE w.project_id = $1::uuid
`;

const isPlannedCrew = async (userId: string, projectId: string) => {
  const r = await query(`SELECT 1 FROM (${plannedCrewSql}) crew WHERE crew.user_id = $2::uuid`, [projectId, userId]);
  return r.rows.length > 0;
};

const isAddedMember = async (userId: string, channelId: string) => {
  const r = await query(`SELECT 1 FROM chat_members WHERE channel_id = $1::uuid AND user_id = $2::uuid`, [channelId, userId]);
  return r.rows.length > 0;
};

export const canAccess = async (user: IChatUser, channel: IChatChannel): Promise<boolean> => {
  if (isStaff(user.role)) return true;
  if (user.role === "CUSTOMER") return channel.kind === "CUSTOMER" && !!user.relation_id && channel.customer_relation_id === user.relation_id;
  if (user.role === "SUBCONTRACTOR") return channel.kind === "SUBCONTRACTOR" && !!user.relation_id && channel.relation_id === user.relation_id;
  if (user.role === "FIELD") {
    if (channel.kind === "SUBCONTRACTOR") return false;
    if (await isAddedMember(user.id, channel.id)) return true;
    return channel.kind === "INTERNAL" && (await isPlannedCrew(user.id, channel.project_id));
  }
  return false;
};

// A channel you may not see does not exist as far as you are concerned
export const requireChannel = async (user: IChatUser, channelId: string) => {
  const channel = await loadChannel(channelId);
  if (!(await canAccess(user, channel))) throw notFound();
  return channel;
};

export const assertWritable = (channel: IChatChannel) => {
  if (channel.read_only) {
    throw new ApiError(httpStatus.CONFLICT, `This project was closed more than ${READ_ONLY_AFTER_DAYS} days ago. The chat is read-only!`);
  }
};

// The customer and internal channels always exist; a subcontractor channel exists once that company
// has a sent assignment on the project
export const ensureChannels = async (projectId: string, client?: any) => {
  const run = client ? client.query.bind(client) : query;
  await run(`INSERT INTO chat_channels (project_id, kind) VALUES ($1::uuid, 'CUSTOMER'), ($1::uuid, 'INTERNAL') ON CONFLICT DO NOTHING`, [projectId]);
  await run(
    `INSERT INTO chat_channels (project_id, kind, relation_id)
     SELECT DISTINCT sa.project_id, 'SUBCONTRACTOR', sa.subcontractor_id FROM subcontract_assignments sa
     WHERE sa.project_id = $1::uuid AND sa.status <> 'DRAFT' ON CONFLICT DO NOTHING`,
    [projectId],
  );
};

// ---------------------------------------------------------------------------
// Who is in a channel (for the live push, notifications and the member list)
// ---------------------------------------------------------------------------

export interface IAudienceMember {
  id: string;
  name: string;
  role: string;
  source: "staff" | "customer" | "subcontractor" | "planned" | "added";
}

export const audienceOf = async (channel: IChatChannel): Promise<IAudienceMember[]> => {
  const members: IAudienceMember[] = [];
  const add = (rows: any[], source: IAudienceMember["source"]) => rows.forEach((r) => members.push({ id: r.id, name: r.name, role: r.role, source }));

  add((await query(`SELECT id, name, role::text AS role FROM users WHERE is_active AND status = 'ACTIVE' AND role::text = ANY($1::text[])`, [[...staffRoles]])).rows, "staff");

  if (channel.kind === "CUSTOMER") {
    add((await query(`SELECT id, name, role::text AS role FROM users WHERE relation_id = $1::uuid AND role::text = 'CUSTOMER' AND is_active AND status = 'ACTIVE'`, [channel.customer_relation_id])).rows, "customer");
  }
  if (channel.kind === "SUBCONTRACTOR") {
    add((await query(`SELECT id, name, role::text AS role FROM users WHERE relation_id = $1::uuid AND role::text = 'SUBCONTRACTOR' AND is_active AND status = 'ACTIVE'`, [channel.relation_id])).rows, "subcontractor");
  }
  if (channel.kind === "INTERNAL") {
    add(
      (await query(
        `SELECT u.id, u.name, u.role::text AS role FROM users u
         WHERE u.id IN (${plannedCrewSql}) AND u.is_active AND u.status = 'ACTIVE' AND u.role::text = 'FIELD'`,
        [channel.project_id],
      )).rows,
      "planned",
    );
  }
  if (channel.kind !== "SUBCONTRACTOR") {
    add(
      (await query(
        `SELECT u.id, u.name, u.role::text AS role FROM chat_members m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = $1::uuid AND u.is_active AND u.status = 'ACTIVE' AND u.role::text = 'FIELD'`,
        [channel.id],
      )).rows,
      "added",
    );
  }

  // one entry per person
  const seen = new Set<string>();
  return members.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
};

// ---------------------------------------------------------------------------
// Unread
// ---------------------------------------------------------------------------

export const unreadSql = (channelRef: string, userParam: string) => `
  (SELECT COUNT(*)::int FROM chat_messages m
   WHERE m.channel_id = ${channelRef} AND m.deleted_at IS NULL AND m.author_id IS DISTINCT FROM ${userParam}::uuid
     AND m.created_at > COALESCE((SELECT r.last_read_at FROM chat_reads r WHERE r.channel_id = ${channelRef} AND r.user_id = ${userParam}::uuid), 'epoch'::timestamptz))
`;

export const unreadFor = async (channelId: string, userId: string) => {
  const r = await query(`SELECT ${unreadSql("$1::uuid", "$2")} AS n`, [channelId, userId]);
  return r.rows[0].n as number;
};

export const pushChatUnread = async (channel: Pick<IChatChannel, "id" | "project_id">, userId: string) => {
  try {
    emitToUser(userId, "chat:unread", { channel_id: channel.id, project_id: channel.project_id, unread: await unreadFor(channel.id, userId) });
  } catch {
    // the push is a convenience
  }
};

// ---------------------------------------------------------------------------
// How a message looks to the person reading it
// ---------------------------------------------------------------------------

export const messageSelect = `
  m.id, m.channel_id, m.body, m.created_at AS "createdAt", m.edited_at, m.deleted_at, m.author_id,
  u.name AS author_name, u.role::text AS author_role,
  COALESCE((
    SELECT json_agg(json_build_object('id', f.id, 'file_name', f.file_name, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes, 'file_url', f.file_url) ORDER BY f.created_at, f.id)
    FROM project_files f WHERE f.chat_message_id = m.id
  ), '[]'::json) AS files
`;

// `external` viewers (customers, subcontractors) get first names and a role label, and no user ids
export const shapeMessage = (row: any, viewer: { id: string; external: boolean }) => {
  const deleted = !!row.deleted_at;
  const role = row.author_role as string | null;
  const fullName = row.author_name as string | null;
  const shown = fullName ? (viewer.external ? fullName.split(/\s+/)[0] : fullName) : "Former user";
  return {
    id: row.id,
    channel_id: row.channel_id,
    body: deleted ? null : row.body,
    deleted,
    createdAt: row.createdAt,
    edited_at: deleted ? null : row.edited_at,
    author: {
      ...(viewer.external ? {} : { id: row.author_id }),
      name: shown,
      role,
      role_label: role ? (roleLabels[role] ?? role) : null,
    },
    is_mine: row.author_id === viewer.id,
    files: deleted ? [] : row.files,
    // Who has read it: filled in when messages are listed (read_by); a message that was just sent has no readers yet
    read_by: [] as any[],
  };
};

// A person as the viewer may see them: customers and subcontractors get a first name and a role label, and no id
export const shapePerson = (person: { id: string; name: string; role: string }, viewerIsExternal: boolean) => ({
  ...(viewerIsExternal ? {} : { id: person.id }),
  name: viewerIsExternal ? String(person.name ?? "").split(/\s+/)[0] : person.name,
  role: person.role,
  role_label: roleLabels[person.role] ?? person.role,
});

export const channelTitle = (channel: Pick<IChatChannel, "kind" | "project_number">) => `${channel.project_number} (${channelLabels[channel.kind]})`;

// Unread chat messages per project, for the portals' project and assignment lists. `kind` says which
// of the project's channels the person is looking at: the customer channel, or their company's own.
export const chatUnreadByProject = async (userId: string, projectIds: string[], kind: "CUSTOMER" | "SUBCONTRACTOR", relationId: string) => {
  const map = new Map<string, number>();
  if (projectIds.length === 0) return map;
  const r = await query(
    `SELECT c.project_id, ${unreadSql("c.id", "$1")} AS unread FROM chat_channels c
     WHERE c.project_id = ANY($2::uuid[]) AND c.kind = $3 AND ($3 <> 'SUBCONTRACTOR' OR c.relation_id = $4::uuid)`,
    [userId, projectIds, kind, relationId],
  );
  r.rows.forEach((row: any) => map.set(row.project_id, row.unread));
  return map;
};
