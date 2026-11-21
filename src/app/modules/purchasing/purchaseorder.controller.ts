import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { PurchaseOrderService } from "./purchaseorder.service";

const headerFields = [
  "project_id",
  "title",
  "supplier_reference",
  "language",
  "expected_delivery_date",
  "delivery_address",
  "recipient_name",
  "recipient_email",
  "notes",
  "internal_notes",
] as const;

const createPurchaseOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await PurchaseOrderService.createPurchaseOrder(
    pickValidFields(req.body, ["supplier_id", ...headerFields, "lines"]) as any,
    req.user.id,
  );
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: "Purchase order draft created successfully", data: result });
});

const getAllPurchaseOrders = catchAsync(async (req: Request, res: Response) => {
  const result = await PurchaseOrderService.getAllPurchaseOrders(req.query);
  res.status(httpStatus.OK).json({
    success: true,
    statusCode: httpStatus.OK,
    message: "Purchase orders fetched successfully",
    meta: result.meta,
    totals: result.totals,
    data: result.data,
  });
});

const getPurchaseOrderById = catchAsync(async (req: Request, res: Response) => {
  const result = await PurchaseOrderService.getPurchaseOrderById(req.params.id as string);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Purchase order fetched successfully", data: result });
});

const updatePurchaseOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await PurchaseOrderService.updatePurchaseOrder(req.params.id as string, pickValidFields(req.body, [...headerFields]) as any, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Purchase order updated successfully", data: result });
});

const setLines = catchAsync(async (req: Request, res: Response) => {
  const result = await PurchaseOrderService.setLines(req.params.id as string, req.body.lines, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Purchase order lines saved successfully", data: result });
});

const deletePurchaseOrder = catchAsync(async (req: Request, res: Response) => {
  await PurchaseOrderService.deletePurchaseOrder(req.params.id as string, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Purchase order draft deleted successfully", data: null });
});

const orderPurchaseOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await PurchaseOrderService.orderPurchaseOrder(req.params.id as string, pickValidFields(req.body, ["send", "email"]) as any, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Purchase order placed successfully", data: result });
});

const sendPurchaseOrder = catchAsync(async (req: Request, res: Response) => {
  await PurchaseOrderService.sendPurchaseOrder(req.params.id as string, req.body.email, req.user.id);
  const result = await PurchaseOrderService.getPurchaseOrderById(req.params.id as string);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Purchase order sent successfully", data: result });
});

const getPdf = catchAsync(async (req: Request, res: Response) => {
  const { pdf, filename } = await PurchaseOrderService.getPdf(req.params.id as string);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(pdf);
});

const receiveGoods = catchAsync(async (req: Request, res: Response) => {
  const result = await PurchaseOrderService.receiveGoods(req.params.id as string, pickValidFields(req.body, ["lines", "all"]) as any, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Goods received successfully", data: result });
});

const cancelPurchaseOrder = catchAsync(async (req: Request, res: Response) => {
  const result = await PurchaseOrderService.cancelPurchaseOrder(req.params.id as string, req.body.reason, req.user.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Purchase order cancelled successfully", data: result });
});

const getHistory = catchAsync(async (req: Request, res: Response) => {
  const result = await PurchaseOrderService.getHistory(req.params.id as string, req.query);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "History fetched successfully", meta: result.meta, data: result.data });
});

export const PurchaseOrderController = {
  createPurchaseOrder,
  getAllPurchaseOrders,
  getPurchaseOrderById,
  updatePurchaseOrder,
  setLines,
  deletePurchaseOrder,
  orderPurchaseOrder,
  sendPurchaseOrder,
  getPdf,
  receiveGoods,
  cancelPurchaseOrder,
  getHistory,
};
