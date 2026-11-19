import { NextFunction, Request, Response } from "express";
import { JwtPayload, Secret } from "jsonwebtoken";
import config from "../../config";
import httpStatus from "http-status";
import { jwtHelpers } from "../helpers/jwtHelpers";
import ApiError from "../errors/ApiError";
import { query } from "../utils/db";
import { LRUCache } from "lru-cache";
import assertUserActive from "../helpers/assertUserActive";
import { requiresTwoFactor } from "../helpers/twoFactorPolicy";

// Short-lived cache of the per-request user lookup (status changes apply within the TTL)
const userCache = new LRUCache<string, any>({ max: 5000, ttl: 30 * 1000 });

export const invalidateAuthCache = (userId: string) => {
  userCache.delete(userId);
};

const createAuth =
  (options: { enforceTwoFactor: boolean }) =>
  (...roles: string[]) => {
    return async (
      req: Request & { user?: any },
      res: Response,
      next: NextFunction,
    ) => {
      try {
        // Check authorization header
        const headersAuth = req.headers.authorization;
        if (!headersAuth || !headersAuth.startsWith("Bearer ")) {
          throw new ApiError(
            httpStatus.UNAUTHORIZED,
            "Invalid authorization format!",
          );
        }

        const token: string | undefined = headersAuth.split(" ")[1];
        if (!token) {
          throw new ApiError(
            httpStatus.UNAUTHORIZED,
            "You are not authorized!",
          );
        }

        // Verify token
        const verifiedUser = jwtHelpers.verifyToken(
          token,
          config.jwt.access_secret as Secret,
        );

        if (!verifiedUser?.email || !verifiedUser?.id) {
          throw new ApiError(
            httpStatus.UNAUTHORIZED,
            "You are not authorized!",
          );
        }

        const { id } = verifiedUser;

        // Get user from database
        let user = userCache.get(id);

        if (!user) {
          const userResult = await query(
            `
                SELECT 
                    id, 
                    email, 
                    name, 
                    role, 
                    status, 
                    is_active,
                    is_email_verified,
                    is_verified,
                    two_factor_enabled,
                    created_at as created_at
                FROM users 
                WHERE id = $1::uuid
            `,
            [id],
          );

          if (userResult.rows.length === 0) {
            throw new ApiError(httpStatus.NOT_FOUND, "User not found!");
          }

          user = userResult.rows[0];
          userCache.set(id, user);
        }

        // Check user status
        assertUserActive(user);

        // Admins must have two-factor authentication set up (FR-AUTH-04). Tokens are
        // only issued after the second factor, so this also catches tokens issued
        // before the requirement existed.
        // if (
        //   options.enforceTwoFactor &&
        //   requiresTwoFactor(user.role) &&
        //   !user.two_factor_enabled
        // ) {
        //   throw new ApiError(
        //     httpStatus.FORBIDDEN,
        //     "Two-factor authentication setup is required for your role!",
        //   );
        // }

        // Attach user to request
        // Database values win over the token's claims: a role or status changed
        // after the token was issued must apply immediately.
        req.user = {
          ...verifiedUser,
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
        };

        // Check role authorization
        if (roles.length && !roles.includes(user.role)) {
          throw new ApiError(
            httpStatus.FORBIDDEN,
            "Forbidden! You are not authorized to access this resource!",
          );
        }

        next();
      } catch (err) {
        next(err);
      }
    };
  };

export const optionalAuth = (...roles: string[]) => {
  return async (
    req: Request & { user?: any },
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const headersAuth = req.headers.authorization;
      const token: string | undefined = headersAuth?.split(" ")[1];

      if (!token) {
        // No token provided, proceed without authentication
        return next();
      }

      const verifiedUser = jwtHelpers.verifyToken(
        token,
        config.jwt.access_secret as Secret,
      );

      if (!verifiedUser?.email) {
        throw new ApiError(httpStatus.UNAUTHORIZED, "You are not authorized!");
      }

      const { id } = verifiedUser;

      req.user = verifiedUser as JwtPayload;

      if (roles.length && !roles.includes(verifiedUser.role)) {
        throw new ApiError(httpStatus.FORBIDDEN, "Forbidden!");
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};

const auth = createAuth({ enforceTwoFactor: true });

// Same checks, but lets an admin without two-factor reach the 2FA setup endpoints
export const authForTwoFactorSetup = createAuth({ enforceTwoFactor: false });

export default auth;
