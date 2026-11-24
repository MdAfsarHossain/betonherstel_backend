import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import { DashboardService } from "./dashboard.service";

const getDashboard = catchAsync(async (req: Request, res: Response) => {
  const result = await DashboardService.getDashboard({ id: req.user.id, role: req.user.role }, req.query);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Dashboard fetched successfully", data: result });
});

const getRecentEvents = catchAsync(async (req: Request, res: Response) => {
  const result = await DashboardService.getRecentEvents(req.query);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Recent events fetched successfully", meta: result.meta, data: result.data });
});

export const DashboardController = { getDashboard, getRecentEvents };
