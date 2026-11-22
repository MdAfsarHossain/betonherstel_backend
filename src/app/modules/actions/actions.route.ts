import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { ActionController } from "./actions.controller";
import { ActionValidation } from "./actions.validation";
const route = Router();

// Beheerder and Kantoor see and manage every task; Uitvoerder (field crew) only their own
// (permission matrix, section 3.2). The service narrows what each role can see and change.
const internal = auth("SUPERADMIN", "ADMIN", "OFFICE", "FIELD");
const admin = auth("SUPERADMIN", "ADMIN");

route.post(
  "/",
  internal,
  validateRequest(ActionValidation.createAction),
  ActionController.createAction,
);
route.get("/", internal, ActionController.getAllActions);

// Static paths before /:id
route.get("/summary", internal, ActionController.getSummary);
route.post("/jobs/run", admin, ActionController.runJobs);

route.get("/:id", internal, ActionController.getActionById);
route.patch(
  "/:id",
  internal,
  validateRequest(ActionValidation.updateAction),
  ActionController.updateAction,
);
route.post(
  "/:id/complete",
  internal,
  validateRequest(ActionValidation.completeAction),
  ActionController.completeAction,
);
route.post("/:id/reopen", internal, ActionController.reopenAction);
route.delete("/:id", internal, ActionController.deleteAction);

export const ActionRoute = route;
