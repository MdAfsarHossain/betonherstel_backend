import { Router } from "express";
import { WebhookController } from "./webhook.controller";
import { WebsiteHookController } from "../websitehook/websitehook.controller";
// import { WebhooksService } from "./webhooks.service";
import express from "express";
import { rateLimit } from "express-rate-limit";

const route = Router();

// Mollie reports payments here. Small bodies only (it sends "id=tr_..."), and rate limited
// (NFR-SEC-06). Mounted before the global body parsers, so it parses its own.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.WEBHOOK_RATE_LIMIT) || 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many requests!" },
});
route.post(
  "/mollie",
  webhookLimiter,
  express.urlencoded({ extended: false, limit: "10kb" }),
  express.json({ limit: "10kb" }),
  WebhookController.molliePaymentWebhook,
);

// The website posts inquiries here (FR-HOOK-01). JSON or form data; the raw bytes are
// kept so a signature can be checked and a retried delivery recognised.
const keepRaw = (req: any, _res: any, buf: Buffer) => {
  req.rawBody = buf;
};
route.post(
  "/website",
  webhookLimiter,
  express.json({ limit: "100kb", verify: keepRaw }),
  express.urlencoded({ extended: true, limit: "100kb", verify: keepRaw }),
  WebsiteHookController.receive,
);
// Broken JSON or an oversize body: logged, and answered in the same shape as every other refusal
route.use("/website", WebsiteHookController.parseError);

export const WebhookRoute = route;
