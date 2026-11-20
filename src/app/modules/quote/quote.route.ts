import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { fileUploader } from "../../middlewares/multerFileUpload";
import { QuoteController } from "./quote.controller";
import { QuoteValidation } from "./quote.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) have full access to quotations; field
// crew have none (permission matrix, section 3.2). Static paths must stay before "/:id".
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");
const admin = auth("SUPERADMIN", "ADMIN");

// Reusable texts per service type and language: everyone in the office reads, the Beheerder edits
route.get("/templates", staff, QuoteController.getTemplates);

route.put(
  "/templates",
  admin,
  validateRequest(QuoteValidation.upsertTemplate),
  QuoteController.upsertTemplate,
);

route.delete("/templates/:id", admin, QuoteController.deleteTemplate);

// Expire overdue quotations and send follow-up reminders now
route.post("/jobs/run", admin, QuoteController.runJobs);

// Quotations
route.post(
  "/",
  staff,
  validateRequest(QuoteValidation.createQuote),
  QuoteController.createQuote,
);

route.get("/", staff, QuoteController.getAllQuotes);

route.get("/:id", staff, QuoteController.getQuoteById);

route.patch(
  "/:id",
  staff,
  validateRequest(QuoteValidation.updateQuote),
  QuoteController.updateQuote,
);

route.put(
  "/:id/items",
  staff,
  validateRequest(QuoteValidation.setItems),
  QuoteController.setItems,
);

route.delete("/:id", staff, QuoteController.deleteQuote);

// Lifecycle
route.post(
  "/:id/send",
  staff,
  // validateRequest(QuoteValidation.sendQuote),
  QuoteController.sendQuote,
);

route.post(
  "/:id/accept",
  staff,
  validateRequest(QuoteValidation.acceptQuote),
  QuoteController.acceptQuote,
);

route.post(
  "/:id/reject",
  staff,
  validateRequest(QuoteValidation.rejectQuote),
  QuoteController.rejectQuote,
);

route.post("/:id/revise", staff, QuoteController.reviseQuote);

// PDF, revisions, history
route.get("/:id/pdf", staff, QuoteController.getPdf);
route.get("/:id/revisions", staff, QuoteController.getRevisions);
route.get("/:id/history", staff, QuoteController.getHistory);

// Photos and files
route.post(
  "/:id/attachments",
  staff,
  fileUploader.files,
  QuoteController.addAttachments,
);
route.delete(
  "/:id/attachments/:attachmentId",
  staff,
  QuoteController.deleteAttachment,
);

export const QuoteRoute = route;
