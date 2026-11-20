import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { MessageController } from "./message.controller";
import { MessageValidation } from "./messages.validation";
const route = Router();

// Beheerder, Kantoor and Uitvoerder all have messages ("Own messages and tasks" for field crew,
// permission matrix section 3.2). Direct messages are private to sender and recipient.
// Comments on records and the email log are for the office only; the service enforces it.
const internal = auth("SUPERADMIN", "ADMIN", "OFFICE", "FIELD");

route.post(
  "/direct",
  internal,
  validateRequest(MessageValidation.sendDirect),
  MessageController.sendDirect,
);
route.get("/direct", internal, MessageController.getDirectMessages);
route.post("/direct/read-all", internal, MessageController.markAllDirectRead);
route.get("/direct/:id", internal, MessageController.getDirectMessage);

route.post(
  "/comments",
  internal,
  validateRequest(MessageValidation.createComment),
  MessageController.createComment,
);
route.get("/comments", internal, MessageController.getComments);
route.patch(
  "/comments/:id",
  internal,
  validateRequest(MessageValidation.updateComment),
  MessageController.updateComment,
);
route.delete("/comments/:id", internal, MessageController.deleteComment);

route.get("/emails", internal, MessageController.getEmails);

export const MessageRoute = route;

// {{BASE_URL}}/messages/comments?entity_type=quote&entity_id=5c9e2d14-7b8a-4a31-9d52-6f0e1a3b8c77
// {{BASE_URL}}/messages/comments?entity_type=quote&entity_id=5c9e2d14-7b8a-4a31-9d52-6f0e1a3b8c77&page=1&limit=20
