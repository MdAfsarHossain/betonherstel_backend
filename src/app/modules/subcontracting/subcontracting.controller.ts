import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { SubcontractingService } from "./subcontracting.service";

const headerFields = [
  "title",
  "scope_description",
  "agreed_price_excl_vat",
  "vat_code",
  "planned_start",
  "planned_end",
  "work_address",
  "language",
  "recipient_name",
  "recipient_email",
  "internal_notes",
] as const;

const actorOf = (req: Request) => ({ id: req.user.id, role: req.user.role });

const createAssignment = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.createAssignment(
    pickValidFields(req.body, ["project_id", "subcontractor_id", ...headerFields]) as any,
    req.user.id,
  );
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: "Assignment draft created successfully", data: result });
});

const getAllAssignments = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.getAllAssignments(req.query);
  res.status(httpStatus.OK).json({
    success: true,
    statusCode: httpStatus.OK,
    message: "Assignments fetched successfully",
    meta: result.meta,
    totals: result.totals,
    data: result.data,
  });
});

const getSchedule = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.getSchedule(req.query);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Subcontractor schedule fetched successfully", data: result });
});

const getAssignmentById = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.getAssignmentById(req.params.id as string);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Assignment fetched successfully", data: result });
});

const updateAssignment = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.updateAssignment(req.params.id as string, pickValidFields(req.body, [...headerFields]) as any, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Assignment updated successfully", data: result });
});

const deleteAssignment = catchAsync(async (req: Request, res: Response) => {
  await SubcontractingService.deleteAssignment(req.params.id as string, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Assignment draft deleted successfully", data: null });
});

const sendAssignment = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.sendAssignment(req.params.id as string, req.body.email, req.user.id);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.delivery.sent ? "Assignment sent successfully" : "Assignment saved as sent, but the email could not be delivered. Send it again!",
    data: result,
  });
});

const getPdf = catchAsync(async (req: Request, res: Response) => {
  const { pdf, filename } = await SubcontractingService.getPdf(req.params.id as string);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(pdf);
});

const respondAssignment = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.respondAssignment(req.params.id as string, pickValidFields(req.body, ["response", "via", "comment", "proposed_start", "proposed_end"]) as any, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Response recorded successfully", data: result });
});

const reportProgress = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.reportProgress(req.params.id as string, pickValidFields(req.body, ["percent", "note", "via"]) as any, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Progress recorded successfully", data: result });
});

const completeAssignment = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.completeAssignment(req.params.id as string, { note: req.body.note }, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Assignment completed successfully", data: result });
});

const reopenAssignment = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.reopenAssignment(req.params.id as string, req.body.reason, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Assignment reopened successfully", data: result });
});

const cancelAssignment = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.cancelAssignment(req.params.id as string, req.body.reason, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Assignment cancelled successfully", data: result });
});

const recordInvoice = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.recordInvoice(
    req.params.id as string,
    pickValidFields(req.body, ["invoice_number", "invoice_date", "due_date", "amount_excl_vat", "vat_amount", "amount_incl_vat", "vat_code", "description", "internal_notes"]),
    actorOf(req),
  );
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: "Subcontractor invoice recorded successfully", data: result });
});

const addFiles = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.addFiles(req.params.id as string, (req.files as Express.Multer.File[]) ?? [], req.body ?? {}, req.user.id);
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: "Files uploaded successfully", data: result });
});

const deleteFile = catchAsync(async (req: Request, res: Response) => {
  await SubcontractingService.deleteFile(req.params.id as string, req.params.fileId as string, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "File deleted successfully", data: null });
});

const getHistory = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractingService.getHistory(req.params.id as string, req.query);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "History fetched successfully", meta: result.meta, data: result.data });
});

export const SubcontractingController = {
  createAssignment,
  getAllAssignments,
  getSchedule,
  getAssignmentById,
  updateAssignment,
  deleteAssignment,
  sendAssignment,
  getPdf,
  respondAssignment,
  reportProgress,
  completeAssignment,
  reopenAssignment,
  cancelAssignment,
  recordInvoice,
  addFiles,
  deleteFile,
  getHistory,
};
