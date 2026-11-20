import httpStatus from "http-status";
import ApiError from "../errors/ApiError";
import { query } from "./db";

// Finds the id of an active service type by its key (e.g. "balcony_renovation").
// Returns null when no key is given. Used by inquiries, catalogue items and quotations.
export const resolveServiceTypeId = async (key?: string | null, client?: any) => {
  if (!key) return null;
  const run = client ? client.query.bind(client) : query;
  const result = await run(`SELECT id, is_active FROM service_types WHERE key = $1`, [key]);
  if (result.rows.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Unknown service type!");
  }
  if (!result.rows[0].is_active) {
    throw new ApiError(httpStatus.BAD_REQUEST, "This service type is no longer available!");
  }
  return result.rows[0].id as string;
};
