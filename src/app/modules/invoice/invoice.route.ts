import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { InvoiceController } from "./invoice.controller";
import { InvoiceValidation } from "./invoice.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) have full access to invoices; field crew have none
// (permission matrix, section 3.2). The customer portal will read its own invoices later.
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");
const admin = auth("SUPERADMIN", "ADMIN");

// Overviews, exports and jobs (static routes before "/:id")
route.get("/overview", staff, InvoiceController.getOverview);
route.get("/export", staff, InvoiceController.exportCsv);
route.get("/export/pdf", staff, InvoiceController.exportPdfBundle);
route.post("/jobs/run", admin, InvoiceController.runJobs);

route.post(
  "/",
  staff,
  validateRequest(InvoiceValidation.createInvoice),
  InvoiceController.createInvoice,
);
route.get("/", staff, InvoiceController.getAllInvoices);

route.get("/:id", staff, InvoiceController.getInvoiceById);
route.patch(
  "/:id",
  staff,
  validateRequest(InvoiceValidation.updateInvoice),
  InvoiceController.updateInvoice,
);
route.put(
  "/:id/items",
  staff,
  validateRequest(InvoiceValidation.setItems),
  InvoiceController.setItems,
);
route.delete("/:id", staff, InvoiceController.deleteInvoice);

// Issuing locks the invoice; sending emails it with a payment link
route.post(
  "/:id/issue",
  staff,
  validateRequest(InvoiceValidation.issueInvoice),
  InvoiceController.issueInvoice,
);
route.post(
  "/:id/send",
  staff,
  validateRequest(InvoiceValidation.sendInvoice),
  InvoiceController.sendInvoice,
);
route.get("/:id/pdf", staff, InvoiceController.getPdf);
route.post(
  "/:id/credit-note",
  staff,
  validateRequest(InvoiceValidation.createCreditNote),
  InvoiceController.createCreditNote,
);

// Payments
route.post(
  "/:id/payments",
  staff,
  validateRequest(InvoiceValidation.recordPayment),
  InvoiceController.recordPayment,
);
route.delete(
  "/:id/payments/:paymentId",
  admin,
  InvoiceController.deletePayment,
);
route.post("/:id/payment-link", staff, InvoiceController.createPaymentLink);
route.post("/:id/sync-payment", staff, InvoiceController.syncPayments);
route.post(
  "/:id/remind",
  staff,
  validateRequest(InvoiceValidation.remind),
  InvoiceController.remindInvoice,
);

route.get("/:id/history", staff, InvoiceController.getHistory);

export const InvoiceRoute = route;
