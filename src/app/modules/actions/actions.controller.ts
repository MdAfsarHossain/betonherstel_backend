import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { ActionJobs } from "./actions.jobs";
import { ActionService } from "./actions.service";

const actorOf = (req: Request) => ({ id: req.user.id, role: req.user.role });

const createAction = catchAsync(async (req: Request, res: Response) => {
  const result = await ActionService.createAction(pickValidFields(req.body, ["title", "description", "due_date", "assignee_id", "entity"]) as any, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: "Action created successfully", data: result });
});

const getAllActions = catchAsync(async (req: Request, res: Response) => {
  const result = await ActionService.getAllActions(req.query, actorOf(req));
  res.status(httpStatus.OK).json({
    success: true,
    statusCode: httpStatus.OK,
    message: "Actions fetched successfully",
    meta: result.meta,
    totals: result.totals,
    data: result.data,
  });
});

const getSummary = catchAsync(async (req: Request, res: Response) => {
  const result = await ActionService.getSummary(actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Action summary fetched successfully", data: result });
});

const getActionById = catchAsync(async (req: Request, res: Response) => {
  const result = await ActionService.getActionById(req.params.id as string, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Action fetched successfully", data: result });
});

const updateAction = catchAsync(async (req: Request, res: Response) => {
  const result = await ActionService.updateAction(req.params.id as string, pickValidFields(req.body, ["title", "description", "due_date", "assignee_id", "entity"]) as any, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Action updated successfully", data: result });
});

const completeAction = catchAsync(async (req: Request, res: Response) => {
  const result = await ActionService.completeAction(req.params.id as string, req.body.note, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Action completed successfully", data: result });
});

const reopenAction = catchAsync(async (req: Request, res: Response) => {
  const result = await ActionService.reopenAction(req.params.id as string, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Action reopened successfully", data: result });
});

const deleteAction = catchAsync(async (req: Request, res: Response) => {
  await ActionService.deleteAction(req.params.id as string, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Action deleted successfully", data: null });
});

const runJobs = catchAsync(async (_req: Request, res: Response) => {
  const result = await ActionJobs.runScheduledJobs();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Action jobs completed", data: result });
});

export const ActionController = {
  createAction,
  getAllActions,
  getSummary,
  getActionById,
  updateAction,
  completeAction,
  reopenAction,
  deleteAction,
  runJobs,
};
