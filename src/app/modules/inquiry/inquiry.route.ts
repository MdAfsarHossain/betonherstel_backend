import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { fileUploader } from "../../middlewares/multerFileUpload";
import { InquiryController } from "./inquiry.controller";
import { InquiryValidation } from "./inquiry.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) work with inquiries. Field crew have no
// access (permission matrix, section 3.2). Static paths must stay before "/:id".
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");
const admin = auth("SUPERADMIN", "ADMIN");

// Lists for filters and forms, and the dashboard tile
route.get("/options", staff, InquiryController.getOptions);
route.get("/summary", staff, InquiryController.getSummary);

// Pipeline (kanban) view
route.get("/pipeline", staff, InquiryController.getPipeline);

// Status configuration: everyone in the office can read, only the Beheerder changes it
route.get("/statuses", staff, InquiryController.getStatuses);

route.post(
  "/statuses",
  admin,
  validateRequest(InquiryValidation.createStatus),
  InquiryController.createStatus,
);

route.patch(
  "/statuses/:statusId",
  admin,
  validateRequest(InquiryValidation.updateStatus),
  InquiryController.updateStatus,
);

route.delete("/statuses/:statusId", admin, InquiryController.deleteStatus);

// Inquiries
route.post(
  "/",
  staff,
  validateRequest(InquiryValidation.createInquiry),
  InquiryController.createInquiry,
);

route.get("/", staff, InquiryController.getAllInquiries);

route.get("/:id", staff, InquiryController.getInquiryById);

route.patch(
  "/:id",
  staff,
  validateRequest(InquiryValidation.updateInquiry),
  InquiryController.updateInquiry,
);

route.patch(
  "/:id/status",
  staff,
  validateRequest(InquiryValidation.changeStatus),
  InquiryController.changeStatus,
);

// Photos and files
route.post("/:id/photos", staff, fileUploader.files, InquiryController.addPhotos);
route.delete("/:id/photos/:photoId", staff, InquiryController.deletePhoto);

// Notes and history
route.post(
  "/:id/notes",
  staff,
  validateRequest(InquiryValidation.createNote),
  InquiryController.addNote,
);

route.get("/:id/history", staff, InquiryController.getHistory);

export const InquiryRoute = route;
