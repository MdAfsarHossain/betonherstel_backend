import { query } from "../../utils/db";
import { notify, officeUserIds } from "../messages/notification.shared";

// Tell the office about something a subcontractor did on an assignment: the person who made the
// assignment if they are still active in the office, otherwise the whole office.
export const notifyOfficeAboutAssignment = async (assignmentId: string, title: string, body: string | null | undefined, actorId: string) => {
  const found = await query(`SELECT created_by FROM subcontract_assignments WHERE id = $1::uuid`, [assignmentId]);
  const creator = found.rows[0]?.created_by as string | null | undefined;
  const owner = creator
    ? await query(`SELECT id FROM users WHERE id = $1::uuid AND is_active AND status = 'ACTIVE' AND role::text IN ('SUPERADMIN', 'ADMIN', 'OFFICE')`, [creator])
    : { rows: [] };
  await notify(owner.rows.length > 0 ? [creator] : await officeUserIds(), {
    type: "ASSIGNMENT_UPDATE",
    title,
    body: body ?? null,
    entity: { type: "subcontract_assignment", id: assignmentId },
    actorId,
  });
};
