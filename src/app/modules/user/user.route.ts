import { Router } from "express";
import auth from "../../middlewares/auth";
import { UserController } from "./user.controller";
import validateRequest from "../../middlewares/validateRequest";
import { UserValidation } from "./user.validation";
import { fileUploader } from "../../middlewares/multerFileUpload";
import parseBodyData from "../../middlewares/parseBodyData";
const route = Router();

// Own account (any authenticated user)
route.get("/my-profile", auth(), UserController.myProfile);

route.patch(
  "/update-profile",
  auth(),
  fileUploader.avatar,
  parseBodyData,
  validateRequest(UserValidation.updateUser),
  UserController.updateUser,
);

export const UserRoute = route;
