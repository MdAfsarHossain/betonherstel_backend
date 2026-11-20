import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import { query, transaction } from "../../utils/db";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { buildUpdate } from "../../utils/sqlBuilders";
import toKey from "../../utils/toKey";
import { ICreateStatus, IUpdateStatus } from "./inquiry.interface";

// Configurable inquiry statuses (FR-REQ-03). The defaults are Nieuw, In
// behandeling, Schouw gepland, Offerte verstuurd, Gewonnen and Verloren; the
// Beheerder can rename, recolour and reorder them and add more.

const statusColumns = `
  s.id, s.key, s.label_nl, s.label_en, s.kind, s.color, s.sort_order,
  s.is_active, s.is_system,
  s.created_at as "createdAt", s.updated_at as "updatedAt"
`;

const getStatuses = async (onlyActive = false) => {
  const result = await query(
    `
        SELECT ${statusColumns}, COUNT(i.id)::int AS inquiry_count
        FROM inquiry_statuses s
        LEFT JOIN inquiries i ON i.status_id = s.id
        ${onlyActive ? "WHERE s.is_active" : ""}
        GROUP BY s.id
        ORDER BY s.sort_order ASC, s.label_en ASC
    `,
  );
  return result.rows;
};

const getStatusOrThrow = async (id: string) => {
  assertUuid(id, "status id");
  const result = await query(
    `
        SELECT ${statusColumns}, COUNT(i.id)::int AS inquiry_count
        FROM inquiry_statuses s
        LEFT JOIN inquiries i ON i.status_id = s.id
        WHERE s.id = $1::uuid
        GROUP BY s.id
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Status not found!");
  }
  return result.rows[0];
};

const createStatus = async (payload: ICreateStatus, actorId: string) => {
  const key = toKey(payload.label_en);
  if (!key) {
    throw new ApiError(httpStatus.BAD_REQUEST, "The English label needs letters or digits!");
  }

  const existing = await query(`SELECT 1 FROM inquiry_statuses WHERE key = $1`, [key]);
  if (existing.rows.length > 0) {
    throw new ApiError(httpStatus.CONFLICT, "A status with this name already exists!");
  }

  const id = await transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO inquiry_statuses (key, label_nl, label_en, kind, color, sort_order)
       VALUES ($1, $2, $3, $4, COALESCE($5, '#6b7280'), $6)
       RETURNING id`,
      [
        key,
        payload.label_nl.trim(),
        payload.label_en.trim(),
        payload.kind,
        payload.color ?? null,
        payload.sort_order ?? 100,
      ],
    );
    await logAudit(
      { actor_id: actorId, action: "CREATE", entity_type: "inquiry_status", entity_id: result.rows[0].id, changes: { key, kind: payload.kind } },
      client,
    );
    return result.rows[0].id as string;
  });

  return getStatusOrThrow(id);
};

const updateStatus = async (id: string, payload: IUpdateStatus, actorId: string) => {
  const existing = await getStatusOrThrow(id);

  if (payload.is_active === false) {
    if (existing.is_system) {
      throw new ApiError(httpStatus.BAD_REQUEST, "This status is needed by the system and cannot be deactivated!");
    }
    if (existing.inquiry_count > 0) {
      throw new ApiError(
        httpStatus.CONFLICT,
        "This status still has inquiries. Move them to another status first!",
      );
    }
  }

  const { updates, values, paramCount } = buildUpdate(
    {
      label_nl: payload.label_nl?.trim(),
      label_en: payload.label_en?.trim(),
      color: payload.color,
      sort_order: payload.sort_order,
      is_active: payload.is_active,
    },
    { label_nl: "", label_en: "", color: "", sort_order: "", is_active: "" },
  );

  if (updates.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No fields to update");
  }
  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  await transaction(async (client) => {
    await client.query(
      `UPDATE inquiry_statuses SET ${updates.join(", ")} WHERE id = $${paramCount}::uuid`,
      values,
    );
    await logAudit(
      { actor_id: actorId, action: "UPDATE", entity_type: "inquiry_status", entity_id: id, changes: payload },
      client,
    );
  });

  return getStatusOrThrow(id);
};

// Only custom statuses that no inquiry uses can be deleted
const deleteStatus = async (id: string, actorId: string) => {
  const existing = await getStatusOrThrow(id);

  if (existing.is_system) {
    throw new ApiError(httpStatus.BAD_REQUEST, "This status is needed by the system and cannot be deleted!");
  }
  if (existing.inquiry_count > 0) {
    throw new ApiError(
      httpStatus.CONFLICT,
      "This status still has inquiries. Move them to another status first!",
    );
  }

  await transaction(async (client) => {
    await client.query(`DELETE FROM inquiry_statuses WHERE id = $1::uuid`, [id]);
    await logAudit(
      { actor_id: actorId, action: "DELETE", entity_type: "inquiry_status", entity_id: id, changes: { key: existing.key } },
      client,
    );
  });
};

export const InquiryStatusService = {
  getStatuses,
  createStatus,
  updateStatus,
  deleteStatus,
};
