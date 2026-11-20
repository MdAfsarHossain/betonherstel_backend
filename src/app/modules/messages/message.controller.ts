import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { MessageService } from "./message.service";

const actorOf = (req: Request) => ({
  id: req.user.id,
  role: req.user.role,
  name: req.user.name,
});

const sendDirect = catchAsync(async (req: Request, res: Response) => {
  const result = await MessageService.sendDirect(
    pickValidFields(req.body, ["recipient_id", "subject", "body"]) as any,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Message sent successfully",
    data: result,
  });
});

const getDirectMessages = catchAsync(async (req: Request, res: Response) => {
  const result = await MessageService.getDirectMessages(
    req.query,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Messages fetched successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getDirectMessage = catchAsync(async (req: Request, res: Response) => {
  const result = await MessageService.getDirectMessage(
    req.params.id as string,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Message fetched successfully",
    data: result,
  });
});

const markAllDirectRead = catchAsync(async (req: Request, res: Response) => {
  const result = await MessageService.markAllDirectRead(actorOf(req));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Messages marked as read",
    data: result,
  });
});

const createComment = catchAsync(async (req: Request, res: Response) => {
  const result = await MessageService.createComment(
    pickValidFields(req.body, ["entity", "body", "mentions"]) as any,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Comment posted successfully",
    data: result,
  });
});

const getComments = catchAsync(async (req: Request, res: Response) => {
  const result = await MessageService.getComments(req.query, actorOf(req));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Comments fetched successfully",
    meta: result.meta,
    data: result.data,
  });
});

const updateComment = catchAsync(async (req: Request, res: Response) => {
  const result = await MessageService.updateComment(
    req.params.id as string,
    pickValidFields(req.body, ["body", "mentions"]) as any,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Comment updated successfully",
    data: result,
  });
});

const deleteComment = catchAsync(async (req: Request, res: Response) => {
  await MessageService.deleteComment(req.params.id as string, actorOf(req));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Comment deleted successfully",
    data: null,
  });
});

const getEmails = catchAsync(async (req: Request, res: Response) => {
  const result = await MessageService.getEmails(req.query, actorOf(req));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Emails fetched successfully",
    meta: result.meta,
    data: result.data,
  });
});

export const MessageController = {
  sendDirect,
  getDirectMessages,
  getDirectMessage,
  markAllDirectRead,
  createComment,
  getComments,
  updateComment,
  deleteComment,
  getEmails,
};
