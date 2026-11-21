import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { PlanningIcalService } from "./planning.ical.service";
import { PlanningService } from "./planning.service";

const getEmployees = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.getEmployees(req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Employees fetched successfully",
    data: result,
  });
});

const getAppointments = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.getAppointments(req.query, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointments fetched successfully",
    data: result,
  });
});

const getResourceView = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.getResourceView(req.query, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Resource view fetched successfully",
    data: result,
  });
});

const getMySchedule = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.getMySchedule(req.user.id, req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Schedule fetched successfully",
    data: result,
  });
});

const completeMyAppointment = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.completeMyAppointment(req.params.id as string, req.user.id, req.body ?? {});

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.already_completed ? "The appointment was already marked as done" : "The appointment is marked as done",
    data: result,
  });
});

const getAppointmentById = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.getAppointmentById(req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment fetched successfully",
    data: result,
  });
});

const createAppointment = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.createAppointment(
    pickValidFields(req.body, [
      "type",
      "title",
      "starts_at",
      "ends_at",
      "all_day",
      "relation_id",
      "inquiry_id",
      "project_id",
      "address",
      "notes",
      "assignee_ids",
      "send_confirmation",
    ]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Appointment planned successfully",
    data: result,
  });
});

const updateAppointment = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.updateAppointment(
    req.params.id as string,
    pickValidFields(req.body, ["type", "title", "starts_at", "ends_at", "all_day", "project_id", "address", "notes", "assignee_ids"]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment updated successfully",
    data: result,
  });
});

const changeStatus = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.changeStatus(
    req.params.id as string,
    { status: req.body.status, reason: req.body.reason },
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment status updated successfully",
    data: result,
  });
});

const deleteAppointment = catchAsync(async (req: Request, res: Response) => {
  await PlanningService.deleteAppointment(req.params.id as string, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment deleted successfully",
    data: null,
  });
});

const checkConflicts = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.checkConflicts({
    assignee_ids: req.body.assignee_ids,
    starts_at: req.body.starts_at,
    ends_at: req.body.ends_at,
    exclude_appointment_id: req.body.exclude_appointment_id,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.length > 0 ? "Double-booking found" : "No double-booking",
    data: result,
  });
});

const sendConfirmation = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningService.sendConfirmation(req.params.id as string, req.body.email, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Confirmation sent successfully",
    data: result,
  });
});

// Calendar subscription link (FR-PLAN-08)
const createIcalToken = catchAsync(async (req: Request, res: Response) => {
  const token = await PlanningIcalService.createToken(req.user.id);
  // Built from the request so it is right behind a proxy too (trust proxy is on)
  const url = `${req.protocol}://${req.get("host")}/api/v1/planning/ical/${token}.ics`;

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Add this link to your calendar app. It is shown only once; creating a new one replaces it.",
    data: { url, token },
  });
});

const getIcalTokenInfo = catchAsync(async (req: Request, res: Response) => {
  const result = await PlanningIcalService.getTokenInfo(req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Calendar link status fetched successfully",
    data: result,
  });
});

const revokeIcalToken = catchAsync(async (req: Request, res: Response) => {
  await PlanningIcalService.revokeToken(req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Calendar link switched off",
    data: null,
  });
});

// Public: the secret in the URL is the key
const getIcalFeed = catchAsync(async (req: Request, res: Response) => {
  // The secret is 64 hex characters; the link usually ends in ".ics", which is not part of it
  const token = String(req.params.token).replace(/\.ics$/i, "");
  const ics = await PlanningIcalService.buildFeed(token);

  if (!ics) {
    return sendResponse(res, {
      statusCode: httpStatus.NOT_FOUND,
      success: false,
      message: "This calendar link is not valid.",
      data: null,
    });
  }

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(ics);
});

export const PlanningController = {
  getEmployees,
  getAppointments,
  getResourceView,
  getMySchedule,
  completeMyAppointment,
  getAppointmentById,
  createAppointment,
  updateAppointment,
  changeStatus,
  deleteAppointment,
  checkConflicts,
  sendConfirmation,
  createIcalToken,
  getIcalTokenInfo,
  revokeIcalToken,
  getIcalFeed,
};
