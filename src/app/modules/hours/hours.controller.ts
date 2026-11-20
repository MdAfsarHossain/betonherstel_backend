import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { HoursRatesService } from "./hours.rates.service";
import { HoursService } from "./hours.service";

const actorOf = (req: Request) => ({ id: req.user.id, role: String(req.user.role) });

const createEntry = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.createEntry(
    pickValidFields(req.body, [
      "project_id",
      "work_order_id",
      "work_date",
      "minutes",
      "started_at",
      "ended_at",
      "entry_type",
      "is_billable",
      "note",
      "client_id",
      "user_id",
    ]) as any,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Hours registered successfully",
    data: result,
  });
});

const getAllEntries = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.getAllEntries(req.query, req.user.id);

  res.status(httpStatus.OK).json({
    success: true,
    statusCode: httpStatus.OK,
    message: "Hours fetched successfully",
    meta: result.meta,
    totals: result.totals,
    data: result.data,
  });
});

const getMyEntries = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.getMyEntries(req.user.id, req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Your hours fetched successfully",
    data: result,
  });
});

const getBookableProjects = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.getBookableProjects(actorOf(req), req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Projects fetched successfully",
    data: result,
  });
});

const updateEntry = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.updateEntry(
    req.params.id as string,
    pickValidFields(req.body, ["work_date", "minutes", "entry_type", "is_billable", "note"]) as any,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Hours updated successfully",
    data: result,
  });
});

const deleteEntry = catchAsync(async (req: Request, res: Response) => {
  await HoursService.deleteEntry(req.params.id as string, actorOf(req));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Hours deleted successfully",
    data: null,
  });
});

// Timer
const getTimer = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.getTimer(actorOf(req));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Timer fetched successfully",
    data: result,
  });
});

const startTimer = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.startTimer(
    pickValidFields(req.body, ["project_id", "work_order_id", "entry_type", "is_billable", "note"]) as any,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Timer started",
    data: result,
  });
});

const stopTimer = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.stopTimer(pickValidFields(req.body, ["ended_at", "note"]) as any, actorOf(req));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Timer stopped and hours registered",
    data: result,
  });
});

const discardTimer = catchAsync(async (req: Request, res: Response) => {
  await HoursService.discardTimer(actorOf(req));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Timer discarded",
    data: null,
  });
});

// Weekly overview and approval
const getWeek = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.getWeek(req.query, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Weekly overview fetched successfully",
    data: result,
  });
});

const approve = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.approve(
    pickValidFields(req.body, ["entry_ids", "user_id", "week_start"]) as any,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.approved > 0 ? "Hours approved successfully" : "Nothing to approve",
    data: result,
  });
});

const rejectEntry = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.rejectEntry(req.params.id as string, req.body.reason, actorOf(req));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Hours rejected",
    data: result,
  });
});

const unapproveEntry = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.unapproveEntry(req.params.id as string, req.body.reason, actorOf(req));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Hours unapproved",
    data: result,
  });
});

const getBillable = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursService.getBillableForProject(req.params.projectId as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Billable hours fetched successfully",
    data: result,
  });
});

const exportCsv = catchAsync(async (req: Request, res: Response) => {
  const { csv, filename } = await HoursService.exportCsv(req.query);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(csv);
});

// Rates
const getRates = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursRatesService.getRates();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Rates fetched successfully",
    data: result,
  });
});

const getRateHistory = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursRatesService.getRateHistory(req.params.userId as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Rate history fetched successfully",
    data: result,
  });
});

const setRate = catchAsync(async (req: Request, res: Response) => {
  const result = await HoursRatesService.setRate(
    req.params.userId as string,
    pickValidFields(req.body, ["cost_rate", "sales_rate", "effective_from"]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Rate saved successfully",
    data: result,
  });
});

export const HoursController = {
  createEntry,
  getAllEntries,
  getMyEntries,
  getBookableProjects,
  updateEntry,
  deleteEntry,
  getTimer,
  startTimer,
  stopTimer,
  discardTimer,
  getWeek,
  approve,
  rejectEntry,
  unapproveEntry,
  getBillable,
  exportCsv,
  getRates,
  getRateHistory,
  setRate,
};
