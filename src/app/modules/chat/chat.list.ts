import { paginationHelper } from "../../helpers/paginationHelper";
import { query } from "../../utils/db";
import { channelLabels, IChatUser } from "./chat.interface";
import { isExternal, isStaff, unreadSql } from "./chat.shared";

// The chat list: which channels a person may see, and what the list shows for each project. One builder
// is used for `GET /chat/projects` and for the live `chat:list` push, so the two can never differ.

// Which channels a person may see, as SQL. $1 = their id, $2 = their relation.
export const visibility = (user: IChatUser) =>
  `(${visibilityRule(user)} AND $2::uuid IS NOT DISTINCT FROM $2::uuid)`;
const visibilityRule = (user: IChatUser) => {
  if (isStaff(user.role)) return "TRUE";
  if (user.role === "CUSTOMER")
    return "(c.kind = 'CUSTOMER' AND p.relation_id = $2::uuid)";
  if (user.role === "SUBCONTRACTOR")
    return "(c.kind = 'SUBCONTRACTOR' AND c.relation_id = $2::uuid)";
  if (user.role === "FIELD") {
    return `(c.kind <> 'SUBCONTRACTOR' AND (
      EXISTS (SELECT 1 FROM chat_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1::uuid)
      OR (c.kind = 'INTERNAL' AND (
        EXISTS (SELECT 1 FROM appointment_assignees aa JOIN appointments a ON a.id = aa.appointment_id
                WHERE a.project_id = p.id AND a.status <> 'CANCELLED' AND aa.user_id = $1::uuid)
        OR EXISTS (SELECT 1 FROM work_order_assignees wa JOIN work_orders w ON w.id = wa.work_order_id
                   WHERE w.project_id = p.id AND wa.user_id = $1::uuid)
      ))
    ))`;
  }
  return "FALSE";
};

export const readOnlySql = `(p.closed_at IS NOT NULL AND p.closed_at < CURRENT_TIMESTAMP - interval '30 days')`;

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export const channelRows = async (user: IChatUser, projectIds: string[]) => {
  const external = isExternal(user.role);
  const result = await query(
    `
      SELECT c.id, c.project_id, c.kind, c.relation_id,
             CASE WHEN $3::boolean THEN NULL ELSE r.name END AS company,
             ${readOnlySql} AS read_only,
             ${unreadSql("c.id", "$1")} AS unread,
             (SELECT json_build_object(
                'id', m.id, 'createdAt', m.created_at, 'author', CASE WHEN m.author_id IS NULL THEN NULL WHEN $3::boolean THEN split_part(u.name, ' ', 1) ELSE u.name END,
                'preview', left(m.body, 160), 'has_files', EXISTS (SELECT 1 FROM project_files f WHERE f.chat_message_id = m.id))
              FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
              WHERE m.channel_id = c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message
      FROM chat_channels c
      JOIN projects p ON p.id = c.project_id
      LEFT JOIN relations r ON r.id = c.relation_id
      WHERE c.project_id = ANY($4::uuid[]) AND ${visibility(user)}
      ORDER BY CASE c.kind WHEN 'CUSTOMER' THEN 1 WHEN 'INTERNAL' THEN 2 ELSE 3 END, r.name
    `,
    [user.id, user.relation_id, external, projectIds],
  );
  return result.rows.map((c: any) => ({
    id: c.id,
    kind: c.kind,
    label: channelLabels[c.kind as keyof typeof channelLabels],
    company: c.company,
    unread: c.unread,
    read_only: c.read_only,
    last_message: c.last_message,
    project_id: c.project_id,
  }));
};


// One entry of the list per project, in the order of `projectIds`. A project with no channel the person
// may see is left out (it does not exist as far as they are concerned).
export const projectListItems = async (user: IChatUser, projectIds: string[]) => {
  if (projectIds.length === 0) return [];
  const [projects, channels] = await Promise.all([
    query(`SELECT id, number, title FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]),
    channelRows(user, projectIds),
  ]);
  const items: any[] = [];
  for (const id of projectIds) {
    const p = projects.rows.find((x: any) => x.id === id);
    const mine = channels.filter((c: any) => c.project_id === id);
    if (!p || mine.length === 0) continue;
    const times = mine.map((c: any) => c.last_message?.createdAt).filter(Boolean).map((t: any) => new Date(t).getTime());
    items.push({
      project: { id: p.id, number: p.number, title: p.title },
      unread: mine.reduce((n: number, c: any) => n + c.unread, 0),
      last_message_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
      channels: mine.map(({ project_id, ...c }: any) => c),
    });
  }
  return items;
};

const paged = (rows: any[], total: number, page: number, limit: number) => {
  const totalPage = Math.ceil(total / limit);
  return { data: rows, meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 } };
};

// A person's whole chat list, one page: every project they may chat on, the project with the newest
// message first (projects nobody has written in yet come after, newest project first). Used by
// `GET /chat/projects` and by the live `chat:projects` push, so both always show the same order.
export const listProjects = async (user: IChatUser, params: Record<string, any>) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);

  const values: any[] = [user.id, user.relation_id];
  let search = "";
  if (params.searchTerm) {
    values.push(`%${String(params.searchTerm).trim().replace(/[%_\\]/g, "\\$&")}%`);
    search = ` AND (p.number ILIKE $${values.length} OR p.title ILIKE $${values.length})`;
  }
  const having = String(params.unread) === "true" ? "HAVING SUM(v.unread) > 0" : "";
  const visible = `
    SELECT c.project_id, p.created_at AS project_created_at, ${unreadSql("c.id", "$1")} AS unread,
           (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS last_at
    FROM chat_channels c JOIN projects p ON p.id = c.project_id
    WHERE ${visibility(user)}${search}
  `;

  const [rows, count] = await Promise.all([
    query(
      `
        SELECT v.project_id, MAX(v.last_at) AS last_at, SUM(v.unread)::int AS unread
        FROM (${visible}) v GROUP BY v.project_id ${having}
        ORDER BY MAX(v.last_at) DESC NULLS LAST, MAX(v.project_created_at) DESC, v.project_id
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `,
      [...values, limit, skip],
    ),
    query(`SELECT COUNT(*)::int AS total FROM (SELECT v.project_id FROM (${visible}) v GROUP BY v.project_id ${having}) x`, values),
  ]);

  const data = await projectListItems(user, rows.rows.map((r: any) => r.project_id));
  return paged(data, count.rows[0].total, page, limit);
};
