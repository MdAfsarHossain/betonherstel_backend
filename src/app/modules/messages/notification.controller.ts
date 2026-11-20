import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import { NotificationService } from "./notification.service";

const getNotifications = catchAsync(async (req: Request, res: Response) => {
  const result = await NotificationService.getNotifications(req.query, req.user.id);
  res.status(httpStatus.OK).json({
    success: true,
    statusCode: httpStatus.OK,
    message: "Notifications fetched successfully",
    meta: result.meta,
    totals: result.totals,
    data: result.data,
  });
});

const getSummary = catchAsync(async (req: Request, res: Response) => {
  const result = await NotificationService.getSummary(req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Notification summary fetched successfully", data: result });
});

const markRead = catchAsync(async (req: Request, res: Response) => {
  const result = await NotificationService.markRead(req.params.id as string, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Notification marked as read", data: result });
});

const markAllRead = catchAsync(async (req: Request, res: Response) => {
  const result = await NotificationService.markAllRead(req.user.id, req.query.type as string | undefined);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Notifications marked as read", data: result });
});

const markRecordRead = catchAsync(async (req: Request, res: Response) => {
  const result = await NotificationService.markRecordRead(req.body.entity, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Notifications marked as read", data: result });
});

const deleteNotification = catchAsync(async (req: Request, res: Response) => {
  await NotificationService.deleteNotification(req.params.id as string, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Notification deleted successfully", data: null });
});

const clearRead = catchAsync(async (req: Request, res: Response) => {
  const result = await NotificationService.clearRead(req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Read notifications cleared", data: result });
});

const getPreferences = catchAsync(async (req: Request, res: Response) => {
  const result = await NotificationService.getPreferences(req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Notification settings fetched successfully", data: result });
});

const setPreferences = catchAsync(async (req: Request, res: Response) => {
  const result = await NotificationService.setPreferences(req.user.id, req.body.preferences);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Notification settings saved successfully", data: result });
});

export const NotificationController = {
  getNotifications,
  getSummary,
  markRead,
  markAllRead,
  markRecordRead,
  deleteNotification,
  clearRead,
  getPreferences,
  setPreferences,
};
