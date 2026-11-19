import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import httpStatus from "http-status";
import ApiError from "../errors/ApiError";
import { authForTwoFactorSetup } from "./auth";
import { verifyTwoFactorToken } from "../modules/auth/auth.tokens";

// Access for the 2FA setup endpoints. Accepts either
//  - the setup token returned by login to an admin who has no 2FA yet, or
//  - a normal access token (a user turning 2FA on voluntarily).
// For the setup token, req.user.viaSetupToken is true.
const twoFactorSetupAccess = async (
  req: Request & { user?: any },
  res: Response,
  next: NextFunction,
) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid authorization format!");
    }
    const token = header.split(" ")[1];

    // Peek at the claims only to choose the path; verification happens below
    const claims = jwt.decode(token) as { purpose?: string } | null;

    if (claims?.purpose === "2fa-setup") {
      req.user = {
        id: verifyTwoFactorToken(token, "2fa-setup"),
        viaSetupToken: true,
      };
      return next();
    }

    return authForTwoFactorSetup()(req, res, next);
  } catch (err) {
    next(err);
  }
};

export default twoFactorSetupAccess;
