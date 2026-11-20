import httpStatus from "http-status";
import ApiError from "../errors/ApiError";

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Reject malformed ids up front so Postgres doesn't throw a 500 on the ::uuid cast
const assertUuid = (value: unknown, label = "id") => {
  if (typeof value !== "string" || !uuidRegex.test(value)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid ${label}!`);
  }
  return value;
};

export default assertUuid;
