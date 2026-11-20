import { Router } from "express";
import { AdminController } from "./admin.controller";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { AdminValidation } from "./admin.validation";
const route = Router();

// Everything under /admin is for the Beheerder only
route.use(auth("SUPERADMIN", "ADMIN"));

// User management (Admin, Office, Field accounts)
route.get("/users", AdminController.allUsers);

route.post(
  "/users",
  validateRequest(AdminValidation.createUser),
  AdminController.createUser,
);

route.get("/users/:id", AdminController.getUserById);

route.patch(
  "/users/:id",
  validateRequest(AdminValidation.adminUpdateUser),
  AdminController.updateUserByAdmin,
);

route.post("/users/:id/reset-two-factor", AdminController.resetTwoFactor);

export const AdminRoutes = route;
