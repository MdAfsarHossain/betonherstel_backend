import httpStatus from "http-status";
import ApiError from "../errors/ApiError";

// Throws unless the account is allowed to sign in. Used by login, token refresh
// and the auth middleware so they all apply the same rules.
const assertUserActive = (user: {
  status?: string;
  is_active?: boolean | null;
}) => {
  if (user.status === "BLOCKED") {
    throw new ApiError(httpStatus.FORBIDDEN, "Your account is blocked!");
  }

  if (user.status === "INACTIVE") {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Your account is not activated yet!",
    );
  }

  if (user.status === "PENDING") {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Your account is not accepted yet!",
    );
  }

  if (!user.is_active) {
    throw new ApiError(httpStatus.FORBIDDEN, "Your account is deactivated!");
  }
};

export default assertUserActive;
