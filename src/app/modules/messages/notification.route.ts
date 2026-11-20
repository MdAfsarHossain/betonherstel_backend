import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { NotificationController } from "./notification.controller";
import { NotificationValidation } from "./messages.validation";
const route = Router();

// Every employee has their own notifications and their own settings
const internal = auth("SUPERADMIN", "ADMIN", "OFFICE", "FIELD");

route.get("/", internal, NotificationController.getNotifications);

// Static paths before /:id
route.get("/summary", internal, NotificationController.getSummary);
route.get("/preferences", internal, NotificationController.getPreferences);
route.put("/preferences", internal, validateRequest(NotificationValidation.setPreferences), NotificationController.setPreferences);
route.post("/read-all", internal, NotificationController.markAllRead);
route.post("/read-record", internal, validateRequest(NotificationValidation.readEntity), NotificationController.markRecordRead);
route.delete("/read", internal, NotificationController.clearRead);

route.post("/:id/read", internal, NotificationController.markRead);
route.delete("/:id", internal, NotificationController.deleteNotification);

export const NotificationRoute = route;
