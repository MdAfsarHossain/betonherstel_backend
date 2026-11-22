import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { PortalAdminController } from "./portal.controller";
import { PortalValidation } from "./portal.validation";
const route = Router();

// The office side of the customer portal: Beheerder and Kantoor invite and manage portal users
// (FR-PORT-01, FR-PORT-11).
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");

route.post("/users", staff, validateRequest(PortalValidation.inviteUser), PortalAdminController.inviteUser);
route.get("/users", staff, PortalAdminController.getUsers);
route.get("/users/:id", staff, PortalAdminController.getUserById);
route.patch("/users/:id", staff, validateRequest(PortalValidation.updateUser), PortalAdminController.updateUser);
route.post("/users/:id/resend-invitation", staff, PortalAdminController.resendInvitation);


export const PortalAdminRoute = route;
