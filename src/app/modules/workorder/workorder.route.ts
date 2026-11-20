import { Router } from "express";
import auth from "../../middlewares/auth";
import { fileUploader } from "../../middlewares/multerFileUpload";
import validateRequest from "../../middlewares/validateRequest";
import { WorkOrderController } from "./workorder.controller";
import { WorkOrderValidation } from "./workorder.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) have full access. Field crew (FIELD) complete the
// work orders they are assigned to (permission matrix, section 3.2): the service also
// checks the assignment, so crew never reach someone else's work order.
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");
const anyEmployee = auth("SUPERADMIN", "ADMIN", "OFFICE", "FIELD");

// Crew view (static routes before "/:id")
route.get("/my", anyEmployee, WorkOrderController.getMyWorkOrders);
route.get("/my/:id", anyEmployee, WorkOrderController.getMyWorkOrderById);

// Office: create, list, edit
route.post(
  "/",
  staff,
  validateRequest(WorkOrderValidation.createWorkOrder),
  WorkOrderController.createWorkOrder,
);
route.get("/", staff, WorkOrderController.getAllWorkOrders);
route.get("/:id", staff, WorkOrderController.getWorkOrderById);
route.patch(
  "/:id",
  staff,
  validateRequest(WorkOrderValidation.updateWorkOrder),
  WorkOrderController.updateWorkOrder,
);
route.delete("/:id", staff, WorkOrderController.deleteWorkOrder);
route.put(
  "/:id/checklist",
  staff,
  validateRequest(WorkOrderValidation.setChecklist),
  WorkOrderController.setChecklist,
);
route.put(
  "/:id/materials",
  staff,
  validateRequest(WorkOrderValidation.setMaterials),
  WorkOrderController.setMaterials,
);

// Office: review
route.post("/:id/check", staff, WorkOrderController.checkWorkOrder);
route.post(
  "/:id/reopen",
  staff,
  validateRequest(WorkOrderValidation.reopen),
  WorkOrderController.reopenWorkOrder,
);
route.post(
  "/:id/send",
  staff,
  validateRequest(WorkOrderValidation.send),
  WorkOrderController.sendToCustomer,
);
route.get("/:id/history", staff, WorkOrderController.getHistory);

// Crew (and office): doing the work
route.post("/:id/start", anyEmployee, WorkOrderController.startWorkOrder);
route.post(
  "/:id/sync",
  anyEmployee,
  validateRequest(WorkOrderValidation.sync),
  WorkOrderController.syncWorkOrder,
);
route.post(
  "/:id/hours",
  anyEmployee,
  validateRequest(WorkOrderValidation.addHours),
  WorkOrderController.addHours,
);
route.patch(
  "/:id/hours/:hourId",
  anyEmployee,
  validateRequest(WorkOrderValidation.updateHours),
  WorkOrderController.updateHours,
);
route.delete(
  "/:id/hours/:hourId",
  anyEmployee,
  WorkOrderController.deleteHours,
);
route.post(
  "/:id/photos",
  anyEmployee,
  fileUploader.files,
  WorkOrderController.addPhotos,
);
route.delete(
  "/:id/photos/:fileId",
  anyEmployee,
  WorkOrderController.deletePhoto,
);
route.post(
  "/:id/signature",
  anyEmployee,
  validateRequest(WorkOrderValidation.signature),
  WorkOrderController.setSignature,
);
route.post(
  "/:id/complete",
  anyEmployee,
  validateRequest(WorkOrderValidation.complete),
  WorkOrderController.completeWorkOrder,
);
route.get("/:id/pdf", anyEmployee, WorkOrderController.getPdf);

export const WorkOrderRoute = route;
