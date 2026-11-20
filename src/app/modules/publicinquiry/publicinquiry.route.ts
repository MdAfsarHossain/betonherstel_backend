import cors from "cors";
import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { fileUploader } from "../../middlewares/multerFileUpload";
import validateRequest from "../../middlewares/validateRequest";
import { PublicInquiryController } from "./publicinquiry.controller";
import { PublicInquiryValidation } from "./publicinquiry.validation";

const route = Router();

// Websites allowed to post from a browser (comma separated). Without the variable any website may:
// the endpoint is public by design and protected by the limits below, not by CORS.
const websiteOrigins = (process.env.WEBSITE_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// A visitor sends a handful of forms at most; a bot is stopped quickly
const publicLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.PUBLIC_FORM_RATE_LIMIT) || 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests, please try again later!",
  },
});

// Mounted before the global CORS and body parsers in app.ts, so it brings its own
route.use(
  cors({
    origin: websiteOrigins.length > 0 ? websiteOrigins : true,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: false,
  }),
);

// JSON, plain form posts and multipart (with up to 5 photos / PDFs in "files")
route.post(
  "/inquiries",
  publicLimiter,
  express.json({ limit: "50kb" }),
  express.urlencoded({ extended: true, limit: "50kb" }),
  fileUploader.files,
  validateRequest(PublicInquiryValidation.createInquiry),
  PublicInquiryController.createInquiry,
);

export const PublicInquiryRoute = route;
