import { Router } from "express";
import auth from "../../middlewares/auth";
import { fileUploader } from "../../middlewares/multerFileUpload";
import validateRequest from "../../middlewares/validateRequest";
import { SubcontractingController } from "./subcontracting.controller";
import { SubcontractingValidation } from "./subcontracting.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) manage subcontracting; field crew have no access.
// Subcontractors answer through their own portal later (FR-SUBP-*); until then the office
// records their answer and progress here.
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");

route.post("/", staff, validateRequest(SubcontractingValidation.createAssignment), SubcontractingController.createAssignment);
route.get("/", staff, SubcontractingController.getAllAssignments);

// Static paths before /:id
route.get("/schedule", staff, SubcontractingController.getSchedule);

route.get("/:id", staff, SubcontractingController.getAssignmentById);
route.patch("/:id", staff, validateRequest(SubcontractingValidation.updateAssignment), SubcontractingController.updateAssignment);
route.delete("/:id", staff, SubcontractingController.deleteAssignment);

route.post("/:id/send", staff, validateRequest(SubcontractingValidation.sendAssignment), SubcontractingController.sendAssignment);
route.get("/:id/pdf", staff, SubcontractingController.getPdf);

route.post("/:id/respond", staff, validateRequest(SubcontractingValidation.respondAssignment), SubcontractingController.respondAssignment);
route.post("/:id/progress", staff, validateRequest(SubcontractingValidation.reportProgress), SubcontractingController.reportProgress);
route.post("/:id/complete", staff, validateRequest(SubcontractingValidation.completeAssignment), SubcontractingController.completeAssignment);
route.post("/:id/reopen", staff, validateRequest(SubcontractingValidation.reopenAssignment), SubcontractingController.reopenAssignment);
route.post("/:id/cancel", staff, validateRequest(SubcontractingValidation.cancelAssignment), SubcontractingController.cancelAssignment);

route.post("/:id/invoices", staff, validateRequest(SubcontractingValidation.recordInvoice), SubcontractingController.recordInvoice);

route.post("/:id/files", staff, fileUploader.files, SubcontractingController.addFiles);
route.delete("/:id/files/:fileId", staff, SubcontractingController.deleteFile);

route.get("/:id/history", staff, SubcontractingController.getHistory);

export const SubcontractingRoute = route;
