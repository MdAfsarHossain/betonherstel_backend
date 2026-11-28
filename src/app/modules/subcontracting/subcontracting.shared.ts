import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { RelationService } from "../relation/relation.service";
import { TRelationEventType } from "../relation/relation.interface";

// Pieces shared by the subcontracting service and the supplier invoice service.

export const clean = (value: any) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : (value ?? null);

// Locks the row (a single-table select, never a join) so requests take turns
export const lockAssignment = async (client: any, id: string) => {
  assertUuid(id, "assignment id");
  const result = await client.query(
    `
      SELECT id, number, status, project_id, subcontractor_id, title, language::text AS language,
             agreed_price_excl_vat::float8 AS agreed_price_excl_vat, vat_code, vat_reverse_charge,
             progress_percent, to_char(planned_start, 'YYYY-MM-DD') AS planned_start, to_char(planned_end, 'YYYY-MM-DD') AS planned_end
      FROM subcontract_assignments WHERE id = $1::uuid FOR UPDATE
    `,
    [id],
  );
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, "Assignment not found!");
  }
  return result.rows[0];
};

// What happened, on the subcontractor's timeline
export const logAssignmentEvent = (
  client: any,
  subcontractorId: string,
  assignmentId: string,
  eventType: TRelationEventType,
  title: string,
  actorId: string | null,
  extra: { description?: string | null; metadata?: Record<string, any> } = {},
) =>
  RelationService.logRelationEvent(
    subcontractorId,
    {
      event_type: eventType,
      entity_type: "subcontract_assignment",
      entity_id: assignmentId,
      title,
      description: extra.description ?? null,
      metadata: extra.metadata,
      actor_id: actorId,
    },
    client,
  );

// Keeps Afgerond / Gefactureerd in line with the invoices: once an approved (or paid)
// subcontractor invoice exists, a COMPLETED assignment is INVOICED; if the last one goes away
// (unapproved or voided) it is COMPLETED again. Call it inside the transaction that changed
// the invoice.
export const syncAssignmentInvoiced = async (client: any, assignmentId: string | null | undefined, actorId: string | null) => {
  if (!assignmentId) return;
  const locked = await client.query(
    `SELECT id, number, status, subcontractor_id FROM subcontract_assignments WHERE id = $1::uuid FOR UPDATE`,
    [assignmentId],
  );
  const a = locked.rows[0];
  if (!a || !["COMPLETED", "INVOICED"].includes(a.status)) return;

  const count = await client.query(
    `SELECT COUNT(*)::int AS n FROM supplier_invoices WHERE subcontract_assignment_id = $1::uuid AND status IN ('APPROVED', 'PAID')`,
    [assignmentId],
  );
  const hasLive = count.rows[0].n > 0;
  const next = hasLive ? "INVOICED" : "COMPLETED";
  if (next === a.status) return;

  await client.query(`UPDATE subcontract_assignments SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [assignmentId, next]);
  await logAssignmentEvent(
    client,
    a.subcontractor_id,
    assignmentId,
    next === "INVOICED" ? "ASSIGNMENT_INVOICED" : "ASSIGNMENT_UNINVOICED",
    next === "INVOICED" ? `Assignment ${a.number} invoiced` : `Assignment ${a.number} is no longer invoiced`,
    actorId,
  );
  await logAudit({ actor_id: actorId, action: "STATUS_CHANGE", entity_type: "subcontract_assignment", entity_id: assignmentId, changes: { to: next } }, client);
};
