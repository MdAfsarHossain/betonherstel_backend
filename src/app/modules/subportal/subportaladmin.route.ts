import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { PortalValidation } from "../portal/portal.validation";
import { SubPortalAdminController } from "./subportal.controller";
import { SubPortalValidation } from "./subportal.validation";
const route = Router();

// The office side of the subcontractor portal: Beheerder and Kantoor invite and manage portal users
// (FR-SUBP-01).
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");

route.post("/users", staff, validateRequest(PortalValidation.inviteUser), SubPortalAdminController.inviteUser);
route.get("/users", staff, SubPortalAdminController.getUsers);
route.get("/users/:id", staff, SubPortalAdminController.getUserById);
route.patch("/users/:id", staff, validateRequest(PortalValidation.updateUser), SubPortalAdminController.updateUser);
route.post("/users/:id/resend-invitation", staff, SubPortalAdminController.resendInvitation);


export const SubPortalAdminRoute = route;
