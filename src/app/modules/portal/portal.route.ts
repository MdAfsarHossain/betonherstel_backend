import { Router } from "express";
import auth from "../../middlewares/auth";
import { fileUploader } from "../../middlewares/multerFileUpload";
import validateRequest from "../../middlewares/validateRequest";
import { PortalController } from "./portal.controller";
import { PortalValidation } from "./portal.validation";
const route = Router();

// The customer portal: only signed-in customers (role CUSTOMER). Every handler narrows to the
// customer's own relation; a record of someone else answers 404.
const customer = auth("CUSTOMER");

// Public: the login page shows the company name and logo (FR-PORT-12)
route.get("/branding", PortalController.getBranding);

route.get("/me", customer, PortalController.getMe);
route.patch(
  "/me",
  customer,
  validateRequest(PortalValidation.updateMe),
  PortalController.updateMe,
);
route.get("/home", customer, PortalController.getHome);

route.get("/quotes", customer, PortalController.getQuotes);
route.get("/quotes/:id", customer, PortalController.getQuoteById);
route.get("/quotes/:id/pdf", customer, PortalController.getQuotePdf);
route.post(
  "/quotes/:id/accept",
  customer,
  validateRequest(PortalValidation.acceptQuote),
  PortalController.acceptQuote,
);
route.post(
  "/quotes/:id/reject",
  customer,
  validateRequest(PortalValidation.rejectQuote),
  PortalController.rejectQuote,
);

route.get("/projects", customer, PortalController.getProjects);
route.get("/projects/:id", customer, PortalController.getProjectById);
route.get("/work-orders/:id/pdf", customer, PortalController.getWorkOrderPdf);

route.get("/appointments", customer, PortalController.getAppointments);

route.get("/invoices", customer, PortalController.getInvoices);
route.get("/invoices/:id", customer, PortalController.getInvoiceById);
route.get("/invoices/:id/pdf", customer, PortalController.getInvoicePdf);
route.post("/invoices/:id/pay", customer, PortalController.payInvoice);

route.get("/subscriptions", customer, PortalController.getSubscriptions);
route.get("/direct-debit", customer, PortalController.getDirectDebit);
route.post("/direct-debit/start", customer, PortalController.startDirectDebit);

route.get("/inquiries", customer, PortalController.getInquiries);
route.post(
  "/inquiries",
  customer,
  validateRequest(PortalValidation.createInquiry),
  PortalController.createInquiry,
);
route.get("/inquiries/:id", customer, PortalController.getInquiryById);
// route.patch(
//   "/inquiries/:id",
//   customer,
//   validateRequest(PortalValidation.updateInquiry),
//   PortalController.updateInquiry,
// );
route.post(
  "/inquiries/:id/photos",
  customer,
  fileUploader.files,
  PortalController.addInquiryPhotos,
);

export const PortalRoute = route;
