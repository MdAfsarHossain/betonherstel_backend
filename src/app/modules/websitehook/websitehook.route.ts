import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { WebsiteHookController } from "./websitehook.controller";
import { WebsiteHookValidation } from "./websitehook.validation";

// Beheerder only (FR-HOOK-03, FR-HOOK-05). The public receiving endpoint is
// POST /webhooks/website (see webhooks/webhook.route.ts).
const route = Router();
const admin = auth("SUPERADMIN", "ADMIN");

route.get("/", admin, WebsiteHookController.getSettings);
route.put(
  "/",
  admin,
  validateRequest(WebsiteHookValidation.updateSettings),
  WebsiteHookController.updateSettings,
);
route.post("/regenerate-secret", admin, WebsiteHookController.regenerateSecret);
route.post(
  "/test-mapping",
  admin,
  validateRequest(WebsiteHookValidation.testMapping),
  WebsiteHookController.testMapping,
);
route.get("/example", admin, WebsiteHookController.getExample);
route.get("/logs", admin, WebsiteHookController.getLogs);
route.get("/logs/:id", admin, WebsiteHookController.getLogById);

export const WebsiteHookRoute = route;
