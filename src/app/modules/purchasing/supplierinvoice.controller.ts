import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { SupplierInvoiceService } from "./supplierinvoice.service";

const actorOf = (req: Request) => ({ id: req.user.id, role: String(req.user.role) });

const fields = [
  "purchase_order_id",
  "project_id",
  "invoice_number",
  "invoice_date",
  "due_date",
  "amount_excl_vat",
  "vat_amount",
  "amount_incl_vat",
  "vat_code",
  "description",
  "internal_notes",
] as const;

const createSupplierInvoice = catchAsync(async (req: Request, res: Response) => {
  const result = await SupplierInvoiceService.createSupplierInvoice(pickValidFields(req.body, ["supplier_id", "subcontract_assignment_id", ...fields]) as any, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: "Supplier invoice recorded successfully", data: result });
});

const getAllSupplierInvoices = catchAsync(async (req: Request, res: Response) => {
  const result = await SupplierInvoiceService.getAllSupplierInvoices(req.query);
  res.status(httpStatus.OK).json({
    success: true,
    statusCode: httpStatus.OK,
    message: "Supplier invoices fetched successfully",
    meta: result.meta,
    totals: result.totals,
    data: result.data,
  });
});

const getSupplierInvoiceById = catchAsync(async (req: Request, res: Response) => {
  const result = await SupplierInvoiceService.getSupplierInvoiceById(req.params.id as string);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Supplier invoice fetched successfully", data: result });
});

const updateSupplierInvoice = catchAsync(async (req: Request, res: Response) => {
  const result = await SupplierInvoiceService.updateSupplierInvoice(req.params.id as string, pickValidFields(req.body, [...fields]) as any, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Supplier invoice updated successfully", data: result });
});

const uploadFile = catchAsync(async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length > 1) {
    sendResponse(res, { statusCode: httpStatus.BAD_REQUEST, success: false, message: "Upload one document at a time!", data: null });
    return;
  }
  const result = await SupplierInvoiceService.uploadFile(req.params.id as string, files[0], actorOf(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: "Document attached successfully", data: result });
});

const getFile = catchAsync(async (req: Request, res: Response) => {
  const { data, name, mime } = await SupplierInvoiceService.getFile(req.params.id as string);
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `inline; filename="${name.replace(/"/g, "")}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(data);
});

const approve = catchAsync(async (req: Request, res: Response) => {
  const result = await SupplierInvoiceService.approve(req.params.id as string, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Supplier invoice approved", data: result });
});

const unapprove = catchAsync(async (req: Request, res: Response) => {
  const result = await SupplierInvoiceService.unapprove(req.params.id as string, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Supplier invoice unapproved", data: result });
});

const pay = catchAsync(async (req: Request, res: Response) => {
  const result = await SupplierInvoiceService.pay(req.params.id as string, pickValidFields(req.body, ["paid_at", "reference"]) as any, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Supplier invoice marked as paid", data: result });
});

const voidInvoice = catchAsync(async (req: Request, res: Response) => {
  const result = await SupplierInvoiceService.voidInvoice(req.params.id as string, req.body.reason, actorOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Supplier invoice voided", data: result });
});

const getOverview = catchAsync(async (req: Request, res: Response) => {
  const result = await SupplierInvoiceService.getOverview();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Overview fetched successfully", data: result });
});

const exportCsv = catchAsync(async (req: Request, res: Response) => {
  const { csv, filename } = await SupplierInvoiceService.exportCsv(req.query);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(csv);
});

const exportFiles = catchAsync(async (req: Request, res: Response) => {
  const { zip, filename } = await SupplierInvoiceService.exportFiles(req.query);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(zip);
});

const getHistory = catchAsync(async (req: Request, res: Response) => {
  const result = await SupplierInvoiceService.getHistory(req.params.id as string, req.query);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "History fetched successfully", meta: result.meta, data: result.data });
});

export const SupplierInvoiceController = {
  createSupplierInvoice,
  getAllSupplierInvoices,
  getSupplierInvoiceById,
  updateSupplierInvoice,
  uploadFile,
  getFile,
  approve,
  unapprove,
  pay,
  voidInvoice,
  getOverview,
  exportCsv,
  exportFiles,
  getHistory,
};
