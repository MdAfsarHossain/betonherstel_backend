import { Request, Response } from "express";
import httpStatus from "http-status";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import { ChatService } from "./chat.service";

const ok = (
  res: Response,
  message: string,
  data: any,
  meta?: any,
  statusCode: number = httpStatus.OK,
) =>
  sendResponse(res, {
    statusCode,
    success: true,
    message,
    data,
    ...(meta ? { meta } : {}),
  });

const id = (req: Request) => req.params.id as string;

const getProjects = catchAsync(async (req: Request, res: Response) => {
  const r = await ChatService.getProjects(req.user.id, req.query);
  ok(res, "Chats fetched successfully", r.data, r.meta);
});
const getProjectChannels = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Channels fetched successfully",
    await ChatService.getProjectChannels(
      req.user.id,
      req.params.projectId as string,
    ),
  ),
);
const getUnreadSummary = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Unread summary fetched successfully",
    await ChatService.getUnreadSummary(req.user.id),
  ),
);

const getMessages = catchAsync(async (req: Request, res: Response) => {
  const r = await ChatService.getMessages(req.user.id, id(req), req.query);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Messages fetched successfully",
    data: { channel: r.channel, messages: r.data },
    meta: r.meta as any,
  });
});
const sendMessage = catchAsync(async (req: Request, res: Response) => {
  const r = await ChatService.sendMessage(
    req.user.id,
    id(req),
    { body: req.body?.message, client_id: req.body?.client_id },
    (req.files as Express.Multer.File[]) ?? [],
  );
  ok(
    res,
    r.duplicate ? "Message already received" : "Message sent successfully",
    { ...r.message, duplicate: r.duplicate },
    undefined,
    r.duplicate ? httpStatus.OK : httpStatus.CREATED,
  );
});
const editMessage = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Message updated successfully",
    await ChatService.editMessage(req.user.id, id(req), req.body.body),
  ),
);
const deleteMessage = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Message deleted successfully",
    await ChatService.deleteMessage(req.user.id, id(req)),
  ),
);
const markRead = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Chat marked as read",
    await ChatService.markRead(req.user.id, id(req)),
  ),
);

const getMembers = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Members fetched successfully",
    await ChatService.getMembers(req.user.id, id(req)),
  ),
);
const getPresence = catchAsync(async (req: Request, res: Response) => ok(res, "Presence fetched successfully", await ChatService.getPresence(req.user.id, id(req))));
const addMember = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Member added successfully",
    await ChatService.addMember(req.user.id, id(req), req.body.user_id),
  ),
);
const removeMember = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Member removed successfully",
    await ChatService.removeMember(
      req.user.id,
      id(req),
      req.params.userId as string,
    ),
  ),
);

export const ChatController = {
  getProjects,
  getProjectChannels,
  getUnreadSummary,
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  markRead,
  getMembers,
  getPresence,
  addMember,
  removeMember,
};
