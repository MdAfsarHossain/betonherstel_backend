import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";

// A day only has 24 hours: the entries of one employee on one date may not add up to more.
// Shared by the hours module and the work order module, so both enforce it.
export const assertDailyLimit = async (
  client: any,
  userId: string,
  workDate: string,
  minutes: number,
  excludeEntryId: string | null = null,
) => {
  // Concurrent requests for the same person and day take turns (released at commit/rollback), so
  // none of them can read the total before another has written its entry
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hours:${userId}:${workDate}`]);
  const result = await client.query(
    `
      SELECT COALESCE(SUM(minutes), 0)::int AS total
      FROM time_entries
      WHERE user_id = $1::uuid AND work_date = $2::date AND ($3::uuid IS NULL OR id <> $3::uuid)
    `,
    [userId, workDate, excludeEntryId],
  );
  if (result.rows[0].total + minutes > 1440) {
    throw new ApiError(httpStatus.BAD_REQUEST, "That would be more than 24 hours on one day!");
  }
};
