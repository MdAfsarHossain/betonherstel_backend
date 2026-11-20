import { query } from "../../utils/db";
import { createAutomaticAction } from "../actions/actions.shared";
import { TEntityType } from "./snelstart.interface";

// How records get into the SnelStart queue, and how they are withdrawn. Kept free of heavy imports so the invoice
// and purchasing services can call it. It **never throws**: queueing is a convenience, it must never make an
// invoice fail to be issued or approved.

// Sends a record to SnelStart later: an issued sales invoice or credit note, an approved supplier or subcontractor
// invoice. Does nothing while the integration is switched off. The same record is queued once.
export const enqueueSnelStart = async (entityType: TEntityType, entityId: string, actorId: string | null = null) => {
  try {
    const settings = await query(`SELECT is_enabled FROM snelstart_settings WHERE id = TRUE`);
    if (!settings.rows[0]?.is_enabled) return false;
    const result = await query(
      `
        INSERT INTO snelstart_sync_items (entity_type, entity_id, queued_by) VALUES ($1, $2::uuid, $3::uuid)
        ON CONFLICT (entity_type, entity_id) DO UPDATE
          SET status = 'PENDING', step = 'BOOKING', attempts = 0, next_attempt_at = CURRENT_TIMESTAMP, last_error = NULL, last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE snelstart_sync_items.status = 'CANCELLED'
        RETURNING id
      `,
      [entityType, entityId, actorId],
    );
    return result.rows.length > 0;
  } catch (error: any) {
    console.error("❌ Could not queue the record for SnelStart:", error?.message ?? error);
    return false;
  }
};

// A supplier invoice that was approved and is no longer: if it was not sent yet it is withdrawn; if SnelStart already
// has it, the CRM never edits or deletes it there (FR-SNEL-09): the correction is a person's job, so it is flagged.
export const withdrawFromSnelStart = async (entityId: string, reason: string): Promise<"WITHDRAWN" | "NEEDS_MANUAL_CORRECTION" | "NOT_QUEUED"> => {
  try {
    const found = await query(`SELECT id, status FROM snelstart_sync_items WHERE entity_type = 'PURCHASE_INVOICE' AND entity_id = $1::uuid`, [entityId]);
    const item = found.rows[0];
    if (!item) return "NOT_QUEUED";
    if (["PENDING", "FAILED", "SKIPPED"].includes(item.status)) {
      await query(`UPDATE snelstart_sync_items SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid AND status IN ('PENDING', 'FAILED', 'SKIPPED')`, [item.id]);
      await query(`INSERT INTO snelstart_sync_log (item_id, entity_type, entity_id, action, status, message) VALUES ($1::uuid, 'PURCHASE_INVOICE', $2::uuid, 'WITHDRAWN', 'INFO', $3)`, [item.id, entityId, reason]);
      return "WITHDRAWN";
    }
    if (item.status === "SENT" || item.status === "SENDING") {
      const inv = await query(`SELECT invoice_number FROM supplier_invoices WHERE id = $1::uuid`, [entityId]);
      await query(`INSERT INTO snelstart_sync_log (item_id, entity_type, entity_id, action, status, message) VALUES ($1::uuid, 'PURCHASE_INVOICE', $2::uuid, 'NEEDS_CORRECTION', 'INFO', $3)`, [item.id, entityId, `${reason}. SnelStart already has this booking: the CRM does not change it there.`]);
      await createAutomaticAction({
        auto_type: "snelstart_sync_error",
        auto_key: `snelstart_sync_error:correct:${entityId}`,
        title: `SnelStart: supplier invoice ${inv.rows[0]?.invoice_number ?? ""} was changed after it was booked`.replace(/\s+/g, " "),
        description: `${reason}. SnelStart already has this booking and the CRM never edits or deletes a booking there. Correct it in SnelStart by hand.`,
        entity: { type: "supplier_invoice", id: entityId },
      });
      return "NEEDS_MANUAL_CORRECTION";
    }
    return "NOT_QUEUED";
  } catch (error: any) {
    console.error("❌ Could not withdraw the record from SnelStart:", error?.message ?? error);
    return "NOT_QUEUED";
  }
};
