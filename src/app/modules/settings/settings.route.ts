import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { fileUploader } from "../../middlewares/multerFileUpload";
import { SettingsController } from "./settings.controller";
import { SettingsValidation } from "./settings.validation";
import { InvoiceValidation } from "../invoice/invoice.validation";
const route = Router();

// Settings are for the Beheerder only (permission matrix, section 3.2)
route.use(auth("SUPERADMIN", "ADMIN"));

// Company details, numbering, VAT rates, payment terms, reminder schedule
route.get("/company", SettingsController.getCompany);

route.patch(
  "/company",
  validateRequest(SettingsValidation.updateCompany),
  SettingsController.updateCompany,
);

route.put("/company/logo", fileUploader.logo, SettingsController.updateLogo);

// Email templates in Dutch and English
route.get("/email-templates", SettingsController.getEmailTemplates);
route.get("/email-templates/:key/:language", SettingsController.getEmailTemplate);

route.put(
  "/email-templates/:key/:language",
  validateRequest(SettingsValidation.updateEmailTemplate),
  SettingsController.updateEmailTemplate,
);

route.delete(
  "/email-templates/:key/:language",
  SettingsController.resetEmailTemplate,
);

// Service types: what Betonherstel.nl offers (used by inquiries, later quotations and projects)
route.get("/service-types", SettingsController.getServiceTypes);

route.post(
  "/service-types",
  validateRequest(SettingsValidation.createServiceType),
  SettingsController.createServiceType,
);

route.patch(
  "/service-types/:id",
  validateRequest(SettingsValidation.updateServiceType),
  SettingsController.updateServiceType,
);

route.get("/audit-log", SettingsController.getAuditLog);

// Mollie payments: connect with an API key (test_... or live_...), check which methods are on
route.get("/mollie", SettingsController.getMollie);
route.put("/mollie", validateRequest(InvoiceValidation.setMollieKey), SettingsController.saveMollie);
route.delete("/mollie", SettingsController.removeMollie);
route.post("/mollie/test", SettingsController.testMollie);

// Sample PDF with the current letterhead
route.get("/preview-pdf", SettingsController.previewPdf);

export const SettingsRoute = route;
