import { Router } from "express";
import auth from "../../middlewares/auth";
import { fileUploader } from "../../middlewares/multerFileUpload";
import validateRequest from "../../middlewares/validateRequest";
import { ProjectController } from "./project.controller";
import { ProjectValidation } from "./project.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) manage projects. Field crew (FIELD) only see
// the projects they are planned on, without prices (permission matrix, section 3.2).
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");
const admin = auth("SUPERADMIN", "ADMIN");
const anyEmployee = auth("SUPERADMIN", "ADMIN", "OFFICE", "FIELD");

// Crew view (static routes before "/:id")
route.get("/my", anyEmployee, ProjectController.getMyProjects);
route.get("/my/:id", anyEmployee, ProjectController.getMyProjectById);

route.get("/summary", staff, ProjectController.getSummary);

// Configurable statuses (FR-PRJ-02)
route.get("/statuses", staff, ProjectController.getStatuses);
route.post(
  "/statuses",
  admin,
  validateRequest(ProjectValidation.createStatus),
  ProjectController.createStatus,
);
route.patch(
  "/statuses/:statusId",
  admin,
  validateRequest(ProjectValidation.updateStatus),
  ProjectController.updateStatus,
);
route.delete("/statuses/:statusId", admin, ProjectController.deleteStatus);

route.post(
  "/",
  staff,
  validateRequest(ProjectValidation.createProject),
  ProjectController.createProject,
);
route.get("/", staff, ProjectController.getAllProjects);

route.get("/:id", staff, ProjectController.getProjectById);
route.patch(
  "/:id",
  staff,
  validateRequest(ProjectValidation.updateProject),
  ProjectController.updateProject,
);
route.delete("/:id", staff, ProjectController.deleteProject);

route.patch(
  "/:id/status",
  staff,
  validateRequest(ProjectValidation.changeStatus),
  ProjectController.changeStatus,
);

// Budget, additional work and the financial overview (FR-PRJ-03/04/05)
route.put(
  "/:id/budget",
  staff,
  validateRequest(ProjectValidation.setBudget),
  ProjectController.setBudget,
);
route.get("/:id/financials", staff, ProjectController.getFinancials);
route.post(
  "/:id/additional-work",
  staff,
  validateRequest(ProjectValidation.addAdditionalWork),
  ProjectController.addAdditionalWork,
);
route.patch(
  "/:id/additional-work/:lineId",
  staff,
  validateRequest(ProjectValidation.updateAdditionalWork),
  ProjectController.updateAdditionalWork,
);
route.delete(
  "/:id/additional-work/:lineId",
  staff,
  ProjectController.deleteAdditionalWork,
);

// Documents and photos (FR-PRJ-06)
route.get("/:id/files", staff, ProjectController.getFiles);
route.post("/:id/files", staff, fileUploader.files, ProjectController.addFiles);
route.patch(
  "/:id/files/:fileId",
  staff,
  validateRequest(ProjectValidation.updateFile),
  ProjectController.updateFile,
);
route.delete("/:id/files/:fileId", staff, ProjectController.deleteFile);

route.get("/:id/history", staff, ProjectController.getHistory);

export const ProjectRoute = route;
