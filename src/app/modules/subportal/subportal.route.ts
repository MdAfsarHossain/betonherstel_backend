import { Router } from "express";
import auth from "../../middlewares/auth";
import { fileUploader } from "../../middlewares/multerFileUpload";
import validateRequest from "../../middlewares/validateRequest";
import { SubPortalController } from "./subportal.controller";
import { SubPortalValidation } from "./subportal.validation";
const route = Router();

// The subcontractor portal: only signed-in subcontractors (role SUBCONTRACTOR). Every handler
// narrows to assignments issued to the subcontractor's own company; anything else answers 404.
const sub = auth("SUBCONTRACTOR");

route.get("/me", sub, SubPortalController.getMe);
route.patch("/me", sub, validateRequest(SubPortalValidation.updateMe), SubPortalController.updateMe);
route.patch("/company", sub, validateRequest(SubPortalValidation.updateCompany), SubPortalController.updateCompany);
route.get("/home", sub, SubPortalController.getHome);

route.get("/assignments", sub, SubPortalController.getAssignments);
route.get("/assignments/:id", sub, SubPortalController.getAssignmentById);
route.get("/assignments/:id/pdf", sub, SubPortalController.getAssignmentPdf);
route.post("/assignments/:id/respond", sub, validateRequest(SubPortalValidation.respond), SubPortalController.respond);
route.post("/assignments/:id/progress", sub, validateRequest(SubPortalValidation.progress), SubPortalController.reportProgress);
route.post("/assignments/:id/complete", sub, validateRequest(SubPortalValidation.complete), SubPortalController.complete);
route.post("/assignments/:id/files", sub, fileUploader.files, SubPortalController.addFiles);
route.delete("/assignments/:id/files/:fileId", sub, SubPortalController.deleteFile);

// The invoice is a form: the PDF plus the amounts (see subportal.validation.ts)
route.post("/assignments/:id/invoices", sub, fileUploader.files, SubPortalController.uploadInvoice);
route.get("/invoices", sub, SubPortalController.getInvoices);
route.get("/invoices/:id", sub, SubPortalController.getInvoiceById);
route.get("/invoices/:id/file", sub, SubPortalController.getInvoiceFile);
route.post("/invoices/:id/file", sub, fileUploader.files, SubPortalController.replaceInvoiceFile);

export const SubPortalRoute = route;
