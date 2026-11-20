import express from "express";
import validateRequest from "../../middlewares/validateRequest";
import { authValidation } from "./auth.validation";
import { AuthControllers } from "./auth.controller";
import auth from "../../middlewares/auth";
import twoFactorSetupAccess from "../../middlewares/twoFactorSetupAccess";

const router = express.Router();

// No public registration: internal users are created by a Beheerder
// (POST /admin/users) and portal users are invited from the relation record.

router.post(
  "/login",
  validateRequest(authValidation.loginUser),
  AuthControllers.loginUser,
);

router.post(
  "/refresh-token",
  validateRequest(authValidation.refreshToken),
  AuthControllers.refreshToken,
);

router.post(
  "/forgot-password",
  validateRequest(authValidation.forgotPassword),
  AuthControllers.forgotPassword,
);

router.post(
  "/reset-password",
  validateRequest(authValidation.resetPassword),
  AuthControllers.resetPassword,
);

router.post(
  "/change-password",
  auth(),
  validateRequest(authValidation.changePassword),
  AuthControllers.changePassword,
);

// Two-factor authentication
router.post(
  "/2fa/verify-login",
  validateRequest(authValidation.twoFactorVerifyLogin),
  AuthControllers.twoFactorVerifyLogin,
);

router.post("/2fa/setup", twoFactorSetupAccess, AuthControllers.twoFactorSetup);

router.post(
  "/2fa/enable",
  twoFactorSetupAccess,
  validateRequest(authValidation.twoFactorEnable),
  AuthControllers.twoFactorEnable,
);

router.post(
  "/2fa/disable",
  auth(),
  validateRequest(authValidation.twoFactorDisable),
  AuthControllers.twoFactorDisable,
);

export const AuthRouters = router;
