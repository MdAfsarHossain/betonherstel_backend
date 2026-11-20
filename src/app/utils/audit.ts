import { query } from "./db";

export interface IAuditEntry {
  actor_id?: string | null;
  action: "CREATE" | "UPDATE" | "DELETE" | string;
  entity_type: string;
  entity_id?: string | null;
  changes?: Record<string, any>;
}

// Records who changed what (FR-SET-06). Financial modules call this too.
// Pass a transaction `client` so the audit row commits or rolls back with the change.
export const logAudit = async (entry: IAuditEntry, client?: any) => {
  const run = client ? client.query.bind(client) : query;
  await run(
    `
        INSERT INTO audit_log (actor_id, action, entity_type, entity_id, changes)
        VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
    `,
    [
      entry.actor_id ?? null,
      entry.action,
      entry.entity_type,
      entry.entity_id ?? null,
      JSON.stringify(entry.changes ?? {}),
    ],
  );
};
