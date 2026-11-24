import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import auth from "../../middlewares/auth";
import { fileUploader } from "../../middlewares/multerFileUpload";
import validateRequest from "../../middlewares/validateRequest";
import { ChatController } from "./chat.controller";
import { ChatValidation } from "./chat.validation";

// Everyone who can be in a project chat: office, admin, field crew, customers and subcontractors. What
// they may see is decided per channel in the service (a channel you may not see answers 404).
const route = Router();
const everyone = auth(
  "SUPERADMIN",
  "ADMIN",
  "OFFICE",
  "FIELD",
  "CUSTOMER",
  "SUBCONTRACTOR",
);
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");

// A person can send this many messages a minute (counted per person, not per address)
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.CHAT_RATE_LIMIT) || 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: any) => String(req.user?.id ?? "anonymous"),
  validate: { keyGeneratorIpFallback: false },
  message: {
    success: false,
    message: "You are sending messages too fast. Wait a moment!",
  },
});

route.get("/projects", everyone, ChatController.getProjects);
route.get(
  "/projects/:projectId/channels",
  everyone,
  ChatController.getProjectChannels,
);
route.get("/unread", everyone, ChatController.getUnreadSummary);

route.get("/channels/:id/messages", everyone, ChatController.getMessages);
route.post(
  "/channels/:id/messages",
  everyone,
  sendLimiter,
  fileUploader.files,
  validateRequest(ChatValidation.sendMessage),
  ChatController.sendMessage,
);
route.post("/channels/:id/read", everyone, ChatController.markRead);

route.get("/channels/:id/presence", everyone, ChatController.getPresence);
route.get("/channels/:id/members", staff, ChatController.getMembers);
route.post(
  "/channels/:id/members",
  staff,
  validateRequest(ChatValidation.addMember),
  ChatController.addMember,
);
route.delete(
  "/channels/:id/members/:userId",
  staff,
  ChatController.removeMember,
);

route.patch(
  "/messages/:id",
  everyone,
  validateRequest(ChatValidation.editMessage),
  ChatController.editMessage,
);
route.delete("/messages/:id", everyone, ChatController.deleteMessage);

export const ChatRoutes = route;
