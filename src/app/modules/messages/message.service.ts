import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { paginationHelper } from "../../helpers/paginationHelper";
import assertUuid from "../../utils/assertUuid";
import { query, transaction } from "../../utils/db";
import { assertRecordExists, assertRecordType, recordLabelSql } from "../../utils/records";
import { notify, pushUnreadCount } from "./notification.shared";

// Berichten (SRS 4.16): direct messages between employees (FR-MSG-01) and comments on a record
// with @mentions (FR-MSG-01), plus the emails logged on a record (FR-MSG-02).
// Direct messages are private: only the sender and the recipient can read them, not even the
// Beheerder. Comments are for the office (field crew have no access to the records they are on).

export interface IMsgActor {
  id: string;
  role: string;
  name?: string;
}

const staffRoles = ["SUPERADMIN", "ADMIN", "OFFICE"];
const internalRoles = [...staffRoles, "FIELD"];
const isStaff = (actor: IMsgActor) => staffRoles.includes(actor.role);

const clean = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : (value ?? null);

const paged = (rows: any[], total: number, page: number, limit: number) => {
  const totalPage = Math.ceil(total / limit);
  return { data: rows, meta: { page, limit, total, totalPage, hasNextPage: page < totalPage, hasPrevPage: page > 1 } };
};

const nameOf = async (userId: string) => (await query(`SELECT name FROM users WHERE id = $1::uuid`, [userId])).rows[0]?.name ?? "Someone";

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

const directColumns = `
  m.id, m.subject, m.body, m.read_at, m.created_at AS "createdAt",
  CASE WHEN m.author_id IS NULL THEN NULL ELSE json_build_object('id', au.id, 'name', au.name) END AS author,
  json_build_object('id', ru.id, 'name', ru.name) AS recipient
`;
const directJoins = `LEFT JOIN users au ON au.id = m.author_id JOIN users ru ON ru.id = m.recipient_id`;

const sendDirect = async (input: { recipient_id: string; subject?: string | null; body: string }, actor: IMsgActor) => {
  assertUuid(input.recipient_id, "recipient id");
  if (input.recipient_id === actor.id) {
    throw new ApiError(httpStatus.BAD_REQUEST, "You cannot send a message to yourself!");
  }
  const recipient = await query(
    `SELECT id FROM users WHERE id = $1::uuid AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`,
    [input.recipient_id, internalRoles],
  );
  if (recipient.rows.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The recipient must be an active employee!");
  }

  const created = await query(
    `INSERT INTO messages (kind, author_id, recipient_id, subject, body) VALUES ('DIRECT', $1::uuid, $2::uuid, $3, $4) RETURNING id`,
    [actor.id, input.recipient_id, clean(input.subject), input.body.trim()],
  );
  const id = created.rows[0].id as string;

  const sender = actor.name ?? (await nameOf(actor.id));
  await notify([input.recipient_id], {
    type: "MESSAGE",
    title: `New message from ${sender}${clean(input.subject) ? `: ${clean(input.subject)}` : ""}`,
    body: input.body,
    data: { message_id: id },
    actorId: actor.id,
  });

  const read = await query(`SELECT ${directColumns} FROM messages m ${directJoins} WHERE m.id = $1::uuid`, [id]);
  return read.rows[0];
};

// box = inbox (default) or sent
const getDirectMessages = async (params: Record<string, any>, actor: IMsgActor) => {
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);
  const box = String(params.box ?? "inbox").toLowerCase();
  if (!["inbox", "sent"].includes(box)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Box should be inbox or sent!");
  }

  const conditions = [`m.kind = 'DIRECT'`, box === "inbox" ? `m.recipient_id = $1::uuid` : `m.author_id = $1::uuid`];
  const values: any[] = [actor.id];
  let n = 2;
  if (String(params.unread) === "true" && box === "inbox") conditions.push(`m.read_at IS NULL`);
  if (params.with) {
    assertUuid(String(params.with), "user id");
    conditions.push(box === "inbox" ? `m.author_id = $${n++}::uuid` : `m.recipient_id = $${n++}::uuid`);
    values.push(String(params.with));
  }
  if (params.searchTerm) {
    const term = String(Array.isArray(params.searchTerm) ? params.searchTerm[0] : params.searchTerm)
      .trim()
      .replace(/[\\%_]/g, "\\$&");
    conditions.push(`(m.subject ILIKE $${n} OR m.body ILIKE $${n})`);
    values.push(`%${term}%`);
    n++;
  }
  const where = conditions.join(" AND ");

  const [rows, count] = await Promise.all([
    query(`SELECT ${directColumns} FROM messages m ${directJoins} WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT $${n} OFFSET $${n + 1}`, [...values, limit, skip]),
    query(`SELECT COUNT(*)::int AS total FROM messages m WHERE ${where}`, values),
  ]);
  return paged(rows.rows, count.rows[0].total, page, limit);
};

// Opening a message marks it as read (for its recipient). Not yours = 404.
const getDirectMessage = async (id: string, actor: IMsgActor) => {
  assertUuid(id, "message id");
  const result = await query(
    `SELECT ${directColumns}, m.author_id, m.recipient_id FROM messages m ${directJoins}
     WHERE m.id = $1::uuid AND m.kind = 'DIRECT' AND (m.author_id = $2::uuid OR m.recipient_id = $2::uuid)`,
    [id, actor.id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Message not found!");
  }
  const { author_id, recipient_id, ...message } = result.rows[0];
  if (recipient_id === actor.id && !message.read_at) {
    const marked = await query(`UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE id = $1::uuid AND read_at IS NULL RETURNING read_at`, [id]);
    message.read_at = marked.rows[0]?.read_at ?? message.read_at;
    // the notification about it is read too
    const readNotes = await query(`UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = $1::uuid AND type = 'MESSAGE' AND read_at IS NULL AND data->>'message_id' = $2 RETURNING id`, [actor.id, id]);
    await pushUnreadCount(actor.id, { read: readNotes.rows.map((r: any) => r.id) });
  }
  return message;
};

const markAllDirectRead = async (actor: IMsgActor) => {
  const result = await query(`UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE kind = 'DIRECT' AND recipient_id = $1::uuid AND read_at IS NULL RETURNING id`, [actor.id]);
  const readNotes = await query(`UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = $1::uuid AND type = 'MESSAGE' AND read_at IS NULL RETURNING id`, [actor.id]);
  await pushUnreadCount(actor.id, { read: readNotes.rows.map((r: any) => r.id) });
  return { marked: result.rows.length };
};

// ---------------------------------------------------------------------------
// Comments on a record, with @mentions
// ---------------------------------------------------------------------------

const commentColumns = `
  m.id, m.body, m.entity_type, m.entity_id, m.edited_at, m.created_at AS "createdAt",
  CASE WHEN m.author_id IS NULL THEN NULL ELSE json_build_object('id', au.id, 'name', au.name) END AS author,
  COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
            FROM message_mentions mm JOIN users u ON u.id = mm.user_id WHERE mm.message_id = m.id), '[]'::json) AS mentions
`;

const assertStaff = (actor: IMsgActor) => {
  if (!isStaff(actor)) {
    throw new ApiError(httpStatus.FORBIDDEN, "Comments on records are for the office!");
  }
};

// Mentions are people who can see the record: office staff, active
const resolveMentions = async (ids: string[] | undefined) => {
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) return [];
  unique.forEach((id) => assertUuid(id, "user id"));
  const found = await query(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`, [unique, staffRoles]);
  if (found.rows.length !== unique.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, "You can only mention active office employees!");
  }
  return unique;
};

const readComment = async (id: string) => {
  const result = await query(`SELECT ${commentColumns} FROM messages m LEFT JOIN users au ON au.id = m.author_id WHERE m.id = $1::uuid AND m.deleted_at IS NULL`, [id]);
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Comment not found!");
  }
  return result.rows[0];
};

const notifyMentions = async (commentId: string, entity: { type: string; id: string }, userIds: string[], body: string, actor: IMsgActor) => {
  if (userIds.length === 0) return;
  const label = (await query(`SELECT ${recordLabelSql("$1::text", "$2::uuid")} AS label`, [entity.type, entity.id])).rows[0]?.label;
  const author = actor.name ?? (await nameOf(actor.id));
  await notify(userIds, {
    type: "MENTION",
    title: `${author} mentioned you${label ? ` on ${label}` : ""}`,
    body,
    entity: { type: entity.type as any, id: entity.id },
    data: { comment_id: commentId },
    actorId: actor.id,
  });
};

const createComment = async (input: { entity: { type: string; id: string }; body: string; mentions?: string[] }, actor: IMsgActor) => {
  assertStaff(actor);
  await assertRecordExists(input.entity.type, input.entity.id);
  const mentioned = await resolveMentions(input.mentions);

  const id = await transaction(async (client) => {
    const created = await client.query(
      `INSERT INTO messages (kind, author_id, body, entity_type, entity_id) VALUES ('COMMENT', $1::uuid, $2, $3, $4::uuid) RETURNING id`,
      [actor.id, input.body.trim(), input.entity.type, input.entity.id],
    );
    for (const userId of mentioned) {
      await client.query(`INSERT INTO message_mentions (message_id, user_id) VALUES ($1::uuid, $2::uuid)`, [created.rows[0].id, userId]);
    }
    return created.rows[0].id as string;
  });

  await notifyMentions(id, input.entity, mentioned, input.body, actor);
  return readComment(id);
};

// An inquiry, its quotations (every revision), the projects made from them and everything on
// those projects belong to one file. Asking for the comments of any of the three gives the whole
// file, so nothing said on the inquiry is missed when the project is opened (and the other way round).
const collectRelatedRecords = async (type: string, id: string) => {
  const inquiries = new Set<string>();
  const quotes = new Set<string>();
  const projects = new Set<string>();
  if (type === "inquiry") inquiries.add(id);
  if (type === "quote") quotes.add(id);
  if (type === "project") projects.add(id);

  // Two rounds are enough to walk inquiry <-> quote <-> project in either direction
  for (let round = 0; round < 2; round++) {
    const q = await query(
      `SELECT id, number, inquiry_id FROM quotes
       WHERE id = ANY($1::uuid[]) OR inquiry_id = ANY($2::uuid[])
          OR number IN (SELECT number FROM quotes WHERE id = ANY($1::uuid[]))
          OR id IN (SELECT quote_id FROM projects WHERE id = ANY($3::uuid[]) OR inquiry_id = ANY($2::uuid[]))`,
      [[...quotes], [...inquiries], [...projects]],
    );
    q.rows.forEach((r: any) => {
      quotes.add(r.id);
      if (r.inquiry_id) inquiries.add(r.inquiry_id);
    });
    const p = await query(
      `SELECT id, quote_id, inquiry_id FROM projects
       WHERE id = ANY($1::uuid[]) OR quote_id = ANY($2::uuid[]) OR inquiry_id = ANY($3::uuid[])`,
      [[...projects], [...quotes], [...inquiries]],
    );
    p.rows.forEach((r: any) => {
      projects.add(r.id);
      if (r.quote_id) quotes.add(r.quote_id);
      if (r.inquiry_id) inquiries.add(r.inquiry_id);
    });
  }

  const inq = [...inquiries];
  const qts = [...quotes];
  const prj = [...projects];
  const ids = async (sql: string, params: any[][]) => (await query(sql, params)).rows.map((r: any) => r.id as string);
  const [appointments, workOrders, invoices, purchaseOrders, supplierInvoices, assignments] = await Promise.all([
    ids(`SELECT id FROM appointments WHERE project_id = ANY($1::uuid[]) OR inquiry_id = ANY($2::uuid[])`, [prj, inq]),
    ids(`SELECT id FROM work_orders WHERE project_id = ANY($1::uuid[])`, [prj]),
    ids(`SELECT id FROM invoices WHERE project_id = ANY($1::uuid[]) OR quote_id = ANY($2::uuid[])`, [prj, qts]),
    ids(`SELECT id FROM purchase_orders WHERE project_id = ANY($1::uuid[])`, [prj]),
    ids(`SELECT id FROM supplier_invoices WHERE project_id = ANY($1::uuid[])`, [prj]),
    ids(`SELECT id FROM subcontract_assignments WHERE project_id = ANY($1::uuid[])`, [prj]),
  ]);

  const pairs: { type: string; id: string }[] = [];
  const add = (kind: string, list: string[]) => list.forEach((i) => pairs.push({ type: kind, id: i }));
  add("inquiry", inq);
  add("quote", qts);
  add("project", prj);
  add("appointment", appointments);
  add("work_order", workOrders);
  add("invoice", invoices);
  add("purchase_order", purchaseOrders);
  add("supplier_invoice", supplierInvoices);
  add("subcontract_assignment", assignments);
  return pairs;
};

// The comments of a record (the whole file for an inquiry, quotation or project, unless related is false).
// No role check: callers are office-only routes.
const queryRecordComments = async (type: string, id: string, related: boolean, limit: number, skip: number) => {
  const wantsFile = ["inquiry", "quote", "project"].includes(type) && related;
  const pairs = wantsFile ? await collectRelatedRecords(type, id) : [{ type, id }];
  if (!pairs.some((x) => x.type === type && x.id === id)) pairs.push({ type, id });
  const types = pairs.map((x) => x.type);
  const recordIds = pairs.map((x) => x.id);

  const filter = `m.kind = 'COMMENT' AND m.deleted_at IS NULL
    AND (m.entity_type, m.entity_id) IN (SELECT x.t, x.i FROM unnest($1::text[], $2::uuid[]) AS x(t, i))`;
  const [rows, count] = await Promise.all([
    query(
      `SELECT ${commentColumns}, ${recordLabelSql("m.entity_type", "m.entity_id")} AS entity_label
       FROM messages m LEFT JOIN users au ON au.id = m.author_id
       WHERE ${filter}
       ORDER BY m.created_at ASC, m.id ASC LIMIT $3 OFFSET $4`,
      [types, recordIds, limit, skip],
    ),
    query(`SELECT COUNT(*)::int AS total FROM messages m WHERE ${filter}`, [types, recordIds]),
  ]);
  return { rows: rows.rows, total: count.rows[0].total as number };
};

// For detail pages (project, quote, inquiry): only the comments written on that exact record, oldest first
const getCommentsOfRecord = async (type: string, id: string, limit = 200) => {
  const { rows, total } = await queryRecordComments(type, id, false, limit, 0);
  return { data: rows, total };
};

// By default only the comments written on that exact record; ?related=true gives the whole file
const getComments = async (params: Record<string, any>, actor: IMsgActor) => {
  assertStaff(actor);
  if (!params.entity_type || !params.entity_id) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Give entity_type and entity_id, like ?entity_type=project&entity_id=...!");
  }
  const type = assertRecordType(String(params.entity_type));
  assertUuid(String(params.entity_id), "record id");
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);

  const { rows, total } = await queryRecordComments(type, String(params.entity_id), String(params.related) === "true", limit, skip);
  return paged(rows, total, page, limit);
};

// Only the author can change a comment. Mentioning someone new notifies only them.
const updateComment = async (id: string, payload: { body?: string; mentions?: string[] }, actor: IMsgActor) => {
  assertStaff(actor);
  assertUuid(id, "comment id");
  const found = await query(`SELECT id, author_id, body, entity_type, entity_id FROM messages WHERE id = $1::uuid AND kind = 'COMMENT' AND deleted_at IS NULL`, [id]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Comment not found!");
  }
  const comment = found.rows[0];
  if (comment.author_id !== actor.id) {
    throw new ApiError(httpStatus.FORBIDDEN, "You can only change your own comments!");
  }
  const mentioned = payload.mentions !== undefined ? await resolveMentions(payload.mentions) : null;

  let added: string[] = [];
  await transaction(async (client) => {
    if (payload.body !== undefined) {
      await client.query(`UPDATE messages SET body = $2, edited_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id, payload.body.trim()]);
    }
    if (mentioned) {
      const before = (await client.query(`SELECT user_id FROM message_mentions WHERE message_id = $1::uuid`, [id])).rows.map((r: any) => r.user_id as string);
      added = mentioned.filter((u) => !before.includes(u));
      await client.query(`DELETE FROM message_mentions WHERE message_id = $1::uuid`, [id]);
      for (const userId of mentioned) {
        await client.query(`INSERT INTO message_mentions (message_id, user_id) VALUES ($1::uuid, $2::uuid)`, [id, userId]);
      }
      if (payload.body === undefined) await client.query(`UPDATE messages SET edited_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
    }
  });

  await notifyMentions(id, { type: comment.entity_type, id: comment.entity_id }, added, payload.body ?? comment.body, actor);
  return readComment(id);
};

// The author, or a Beheerder. The comment is hidden, not erased.
const deleteComment = async (id: string, actor: IMsgActor) => {
  assertStaff(actor);
  assertUuid(id, "comment id");
  const found = await query(`SELECT id, author_id FROM messages WHERE id = $1::uuid AND kind = 'COMMENT' AND deleted_at IS NULL`, [id]);
  if (found.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Comment not found!");
  }
  const isAdmin = ["SUPERADMIN", "ADMIN"].includes(actor.role);
  if (found.rows[0].author_id !== actor.id && !isAdmin) {
    throw new ApiError(httpStatus.FORBIDDEN, "You can only delete your own comments!");
  }
  await query(`UPDATE messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [id]);
};

// ---------------------------------------------------------------------------
// Emails logged on a record (FR-MSG-02)
// ---------------------------------------------------------------------------

const getEmails = async (params: Record<string, any>, actor: IMsgActor) => {
  assertStaff(actor);
  if (!params.entity_type || !params.entity_id) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Give entity_type and entity_id, like ?entity_type=quote&entity_id=...!");
  }
  const type = assertRecordType(String(params.entity_type));
  assertUuid(String(params.entity_id), "record id");
  const { page, limit, skip } = paginationHelper.calculatePagination(params as any);

  const [rows, count] = await Promise.all([
    query(
      `
        SELECT e.id, e.to_email, e.subject, e.template_key, e.language::text AS language, e.status, e.error,
               e.created_at AS "createdAt", CASE WHEN e.sent_by IS NULL THEN NULL ELSE json_build_object('id', u.id, 'name', u.name) END AS sent_by
        FROM email_log e LEFT JOIN users u ON u.id = e.sent_by
        WHERE e.related_type = $1 AND e.related_id = $2::uuid
        ORDER BY e.created_at DESC, e.id DESC LIMIT $3 OFFSET $4
      `,
      [type, params.entity_id, limit, skip],
    ),
    query(`SELECT COUNT(*)::int AS total FROM email_log WHERE related_type = $1 AND related_id = $2::uuid`, [type, params.entity_id]),
  ]);
  return paged(rows.rows, count.rows[0].total, page, limit);
};

export const MessageService = {
  sendDirect,
  getDirectMessages,
  getDirectMessage,
  markAllDirectRead,
  createComment,
  getComments,
  getCommentsOfRecord,
  updateComment,
  deleteComment,
  getEmails,
};
