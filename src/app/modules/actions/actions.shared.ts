import { query } from "../../utils/db";
import { notify } from "../messages/notification.shared";
import { ICreateAutomaticAction } from "./actions.interface";

// Creating an automatic task (FR-MSG-04). Other modules call this when a key event happens.
// It is idempotent (auto_key) and never throws: a task is a convenience, it must never make
// the event that caused it fail.

export const internalRoles = ["SUPERADMIN", "ADMIN", "OFFICE", "FIELD"] as const;
export const staffRoles = ["SUPERADMIN", "ADMIN", "OFFICE"] as const;

export const createAutomaticAction = async (input: ICreateAutomaticAction, client?: any): Promise<{ created: boolean; id?: string }> => {
  const run = client ? client.query.bind(client) : query;
  try {
    // An assignee who has left, or is not active, is the same as nobody: the team picks it up
    let assignee: string | null = input.assignee_id ?? null;
    if (assignee) {
      const ok = await run(`SELECT 1 FROM users WHERE id = $1::uuid AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`, [assignee, [...internalRoles]]);
      if (ok.rows.length === 0) assignee = null;
    }

    const result = await run(
      `
        INSERT INTO actions (title, description, due_date, assignee_id, source, auto_type, auto_key, entity_type, entity_id)
        VALUES ($1, $2, $3::date, $4::uuid, 'AUTOMATIC', $5, $6, $7, $8::uuid)
        ON CONFLICT (auto_key) WHERE auto_key IS NOT NULL DO NOTHING
        RETURNING id
      `,
      [
        input.title.slice(0, 255),
        input.description ?? null,
        input.due_date ?? null,
        assignee,
        input.auto_type,
        input.auto_key,
        input.entity?.type ?? null,
        input.entity?.id ?? null,
      ],
    );
    if (result.rows.length === 0) return { created: false };
    // The person it was given to hears about it (the team pool is covered by the event itself)
    if (assignee) {
      await notify([assignee], {
        type: "ACTION_ASSIGNED",
        title: `Task assigned to you: ${input.title}`,
        body: input.description ?? null,
        entity: input.entity ?? null,
        data: { action_id: result.rows[0].id },
      });
    }
    return { created: true, id: result.rows[0].id };
  } catch (error: any) {
    console.error(`❌ Could not create the automatic task ${input.auto_key}:`, error?.message ?? error);
    return { created: false };
  }
};

// Who should get a task about something someone created: that person if they are still active
// in the office, otherwise nobody (the team pool)
export const activeStaffOrNull = async (userId: string | null | undefined, client?: any) => {
  if (!userId) return null;
  const run = client ? client.query.bind(client) : query;
  const found = await run(`SELECT id FROM users WHERE id = $1::uuid AND is_active AND status = 'ACTIVE' AND role::text = ANY($2::text[])`, [userId, [...staffRoles]]);
  return found.rows.length > 0 ? (userId as string) : null;
};
