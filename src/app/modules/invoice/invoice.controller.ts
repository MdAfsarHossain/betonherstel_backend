import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { InvoiceDeliveryService } from "./invoice.delivery.service";
import { InvoicePaymentService } from "./invoice.payment.service";
import { InvoiceService } from "./invoice.service";

const headerFields = [
  "title",
  "language",
  "payment_term_days",
  "recipient_name",
  "recipient_email",
  "intro_text",
  "footer_text",
  "internal_notes",
] as const;

const createInvoice = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoiceService.createInvoice(
    pickValidFields(req.body, [
      "source",
      "relation_id",
      "quote_id",
      "project_id",
      "include",
      "percentage",
      "amount",
      "sections",
      ...headerFields,
    ]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Invoice draft created successfully",
    data: result,
  });
});

const getAllInvoices = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoiceService.getAllInvoices(req.query);

  res.status(httpStatus.OK).json({
    success: true,
    statusCode: httpStatus.OK,
    message: "Invoices fetched successfully",
    meta: result.meta,
    totals: result.totals,
    data: result.data,
  });
});

const getInvoiceById = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoiceService.getInvoiceById(req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invoice fetched successfully",
    data: result,
  });
});

const updateInvoice = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoiceService.updateInvoice(
    req.params.id as string,
    pickValidFields(req.body, [...headerFields]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invoice updated successfully",
    data: result,
  });
});

const setItems = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoiceService.setItems(
    req.params.id as string,
    req.body.sections,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invoice lines saved successfully",
    data: result,
  });
});

const deleteInvoice = catchAsync(async (req: Request, res: Response) => {
  await InvoiceService.deleteInvoice(req.params.id as string, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invoice draft deleted successfully",
    data: null,
  });
});

const issueInvoice = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoiceService.issueInvoice(
    req.params.id as string,
    pickValidFields(req.body, ["send", "email"]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invoice issued successfully",
    data: result,
  });
});

const sendInvoice = catchAsync(async (req: Request, res: Response) => {
  await InvoiceDeliveryService.sendInvoice(
    req.params.id as string,
    req.body.email,
    req.user.id,
  );
  const result = await InvoiceService.getInvoiceById(req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invoice sent successfully",
    data: result,
  });
});

const getPdf = catchAsync(async (req: Request, res: Response) => {
  const { pdf, filename } = await InvoiceService.getPdf(
    req.params.id as string,
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(pdf);
});

const createCreditNote = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoiceService.createCreditNote(
    req.params.id as string,
    pickValidFields(req.body, ["reason", "lines"]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Credit note draft created successfully",
    data: result,
  });
});

const recordPayment = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoicePaymentService.recordPayment(
    req.params.id as string,
    pickValidFields(req.body, [
      "amount",
      "paid_at",
      "method",
      "reference",
    ]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Payment recorded successfully",
    data: result,
  });
});

const deletePayment = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoicePaymentService.deletePayment(
    req.params.id as string,
    req.params.paymentId as string,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Payment removed successfully",
    data: result,
  });
});

const createPaymentLink = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoicePaymentService.createPaymentLink(
    req.params.id as string,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Payment link created successfully",
    data: result,
  });
});

const syncPayments = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoicePaymentService.syncPayments(
    req.params.id as string,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Payment status updated from Mollie",
    data: result,
  });
});

const remindInvoice = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoiceDeliveryService.remindInvoice(
    req.params.id as string,
    req.body.email,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Payment reminder sent successfully",
    data: result,
  });
});

const getOverview = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoiceService.getOverview();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Overview fetched successfully",
    data: result,
  });
});

const exportCsv = catchAsync(async (req: Request, res: Response) => {
  const { csv, filename } = await InvoiceService.exportCsv(req.query);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(csv);
});

const exportPdfBundle = catchAsync(async (req: Request, res: Response) => {
  const { zip, filename } = await InvoiceService.exportPdfBundle(req.query);

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(zip);
});

const getHistory = catchAsync(async (req: Request, res: Response) => {
  const result = await InvoiceService.getHistory(
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

const runJobs = catchAsync(async (req: Request, res: Response) => {
  const reminders = await InvoiceDeliveryService.sendDueReminders();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invoice jobs ran successfully",
    data: { reminders_sent: reminders },
  });
});

export const InvoiceController = {
  createInvoice,
  getAllInvoices,
  getInvoiceById,
  updateInvoice,
  setItems,
  deleteInvoice,
  issueInvoice,
  sendInvoice,
  getPdf,
  createCreditNote,
  recordPayment,
  deletePayment,
  createPaymentLink,
  syncPayments,
  remindInvoice,
  getOverview,
  exportCsv,
  exportPdfBundle,
  getHistory,
  runJobs,
};
