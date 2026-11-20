import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { WorkOrderService } from "./workorder.service";

const actorOf = (req: Request) => ({
  id: req.user.id,
  role: String(req.user.role),
});

const createWorkOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.createWorkOrder(
    pickValidFields(req.body, [
      "project_id",
      "appointment_id",
      "title",
      "instructions",
      "planned_date",
      "address",
      "internal_notes",
      "assignee_ids",
      "checklist",
      "materials",
    ]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Work order created successfully",
    data: result,
  });
});

const getAllWorkOrders = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.getAllWorkOrders(
    req.query,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work orders fetched successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getWorkOrderById = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.getWorkOrderById(
    req.params.id as string,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work order fetched successfully",
    data: result,
  });
});

const getMyWorkOrders = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.getMyWorkOrders(req.user.id, req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work orders fetched successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getMyWorkOrderById = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.getMyWorkOrderById(
    req.user.id,
    req.params.id as string,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work order fetched successfully",
    data: result,
  });
});

const updateWorkOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.updateWorkOrder(
    req.params.id as string,
    pickValidFields(req.body, [
      "title",
      "instructions",
      "planned_date",
      "address",
      "internal_notes",
      "assignee_ids",
    ]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work order updated successfully",
    data: result,
  });
});

const deleteWorkOrder = catchAsync(async (req: Request, res: Response) => {
  await WorkOrderService.deleteWorkOrder(req.params.id as string, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work order deleted successfully",
    data: null,
  });
});

const setChecklist = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.setChecklist(
    req.params.id as string,
    req.body.items,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Checklist saved successfully",
    data: result,
  });
});

const setMaterials = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.setMaterials(
    req.params.id as string,
    req.body.items,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Materials saved successfully",
    data: result,
  });
});

const startWorkOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.startWorkOrder(
    req.params.id as string,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work order started",
    data: result,
  });
});

const syncWorkOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.syncWorkOrder(
    req.params.id as string,
    pickValidFields(req.body, [
      "work_performed",
      "notes",
      "checklist",
      "materials",
      "extra_materials",
      "hours",
    ]) as any,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work order saved successfully",
    data: result,
  });
});

const addHours = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.addHours(
    req.params.id as string,
    pickValidFields(req.body, [
      "client_id",
      "user_id",
      "work_date",
      "minutes",
      "entry_type",
      "is_billable",
      "note",
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

const updateHours = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.updateHours(
    req.params.id as string,
    req.params.hourId as string,
    pickValidFields(req.body, [
      "work_date",
      "minutes",
      "entry_type",
      "is_billable",
      "note",
    ]) as any,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Hours updated successfully",
    data: result,
  });
});

const deleteHours = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.deleteHours(
    req.params.id as string,
    req.params.hourId as string,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Hours deleted successfully",
    data: result,
  });
});

const addPhotos = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.addPhotos(
    req.params.id as string,
    (req.files as Express.Multer.File[]) ?? [],
    req.body ?? {},
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Photos uploaded successfully",
    data: result,
  });
});

const deletePhoto = catchAsync(async (req: Request, res: Response) => {
  await WorkOrderService.deletePhoto(
    req.params.id as string,
    req.params.fileId as string,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Photo deleted successfully",
    data: null,
  });
});

const setSignature = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.setSignature(
    req.params.id as string,
    { signed_by_name: req.body.signed_by_name, signature: req.body.signature },
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Signature saved successfully",
    data: result,
  });
});

const completeWorkOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.completeWorkOrder(
    req.params.id as string,
    pickValidFields(req.body, [
      "work_performed",
      "signed_by_name",
      "signature",
    ]) as any,
    actorOf(req),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work order completed successfully",
    data: result,
  });
});

const checkWorkOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.checkWorkOrder(
    req.params.id as string,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work order checked successfully",
    data: result,
  });
});

const reopenWorkOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.reopenWorkOrder(
    req.params.id as string,
    req.body.reason,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work order reopened successfully",
    data: result,
  });
});

const getPdf = catchAsync(async (req: Request, res: Response) => {
  const { pdf, filename } = await WorkOrderService.getPdf(
    req.params.id as string,
    actorOf(req),
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(pdf);
});

const sendToCustomer = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.sendToCustomer(
    req.params.id as string,
    req.body.email,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Work order sent successfully",
    data: result,
  });
});

const getHistory = catchAsync(async (req: Request, res: Response) => {
  const result = await WorkOrderService.getHistory(
    req.params.id as string,
    req.query,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "History fetched successfully",
    meta: result.meta,
    data: result.data,
  });
});

export const WorkOrderController = {
  createWorkOrder,
  getAllWorkOrders,
  getWorkOrderById,
  getMyWorkOrders,
  getMyWorkOrderById,
  updateWorkOrder,
  deleteWorkOrder,
  setChecklist,
  setMaterials,
  startWorkOrder,
  syncWorkOrder,
  addHours,
  updateHours,
  deleteHours,
  addPhotos,
  deletePhoto,
  setSignature,
  completeWorkOrder,
  checkWorkOrder,
  reopenWorkOrder,
  getPdf,
  sendToCustomer,
  getHistory,
};
