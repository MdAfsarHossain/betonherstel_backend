import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { QuoteJobs } from "./quote.jobs";
import { QuoteService } from "./quote.service";
import { QuoteTemplateService } from "./quote.template.service";

const headerFields = [
  "title",
  "service_type",
  "language",
  "valid_until",
  "recipient_name",
  "recipient_email",
  "address",
  "intro_text",
  "scope_text",
  "conditions_text",
  "warranty_text",
  "internal_notes",
] as const;

const createQuote = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.createQuote(
    pickValidFields(req.body, [
      "inquiry_id",
      "relation_id",
      ...headerFields,
      "sections",
    ]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Quotation created successfully",
    data: result,
  });
});

const getAllQuotes = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.getAllQuotes(req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Quotations fetched successfully",
    data: result.data,
    meta: result.meta,
  });
});

const getQuoteById = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.getQuoteById(req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Quotation fetched successfully",
    data: result,
  });
});

const updateQuote = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.updateQuote(
    req.params.id as string,
    pickValidFields(req.body, [...headerFields]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Quotation updated successfully",
    data: result,
  });
});

const setItems = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.setItems(
    req.params.id as string,
    req.body.sections,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Quotation lines saved successfully",
    data: result,
  });
});

const deleteQuote = catchAsync(async (req: Request, res: Response) => {
  await QuoteService.deleteQuote(req.params.id as string, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Quotation deleted successfully",
    data: null,
  });
});

const sendQuote = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.sendQuote(
    req.params.id as string,
    { email: req.body.email, send_email: req.body.send_email, invite_to_portal: req.body.invite_to_portal },
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Quotation sent successfully",
    data: result,
  });
});

const acceptQuote = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.acceptQuote(
    req.params.id as string,
    {
      accepted_by_name: req.body.accepted_by_name,
      via: req.body.via ?? "OTHER",
      terms_accepted: req.body.terms_accepted,
    },
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Quotation accepted",
    data: result,
  });
});

const rejectQuote = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.rejectQuote(
    req.params.id as string,
    req.body.reason,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Quotation rejected",
    data: result,
  });
});

const reviseQuote = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.reviseQuote(
    req.params.id as string,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Revision created successfully",
    data: result,
  });
});

const getPdf = catchAsync(async (req: Request, res: Response) => {
  const { buffer, filename } = await QuoteService.getPdf(
    req.params.id as string,
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.status(httpStatus.OK).send(buffer);
});

const getRevisions = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.revisionsOf(req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Revisions fetched successfully",
    data: result,
  });
});

const getHistory = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.getHistory(
    req.params.id as string,
    req.query,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "History fetched successfully",
    data: result.data,
    meta: result.meta,
  });
});

const addAttachments = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteService.addAttachments(
    req.params.id as string,
    (req.files as Express.Multer.File[]) ?? [],
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Files uploaded successfully",
    data: result,
  });
});

const deleteAttachment = catchAsync(async (req: Request, res: Response) => {
  await QuoteService.deleteAttachment(
    req.params.id as string,
    req.params.attachmentId as string,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "File deleted successfully",
    data: null,
  });
});

// Texts templates
const getTemplates = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteTemplateService.getTemplates();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Templates fetched successfully",
    data: result,
  });
});

const upsertTemplate = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteTemplateService.upsertTemplate(
    pickValidFields(req.body, [
      "service_type",
      "language",
      "intro_text",
      "scope_text",
      "conditions_text",
      "warranty_text",
    ]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Template saved successfully",
    data: result,
  });
});

const deleteTemplate = catchAsync(async (req: Request, res: Response) => {
  await QuoteTemplateService.deleteTemplate(
    req.params.id as string,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Template deleted successfully",
    data: null,
  });
});

// Run the scheduled jobs now (expiry and follow-up reminders)
const runJobs = catchAsync(async (req: Request, res: Response) => {
  const result = await QuoteJobs.runScheduledJobs();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Scheduled jobs finished",
    data: result,
  });
});

export const QuoteController = {
  createQuote,
  getAllQuotes,
  getQuoteById,
  updateQuote,
  setItems,
  deleteQuote,
  sendQuote,
  acceptQuote,
  rejectQuote,
  reviseQuote,
  getPdf,
  getRevisions,
  getHistory,
  addAttachments,
  deleteAttachment,
  getTemplates,
  upsertTemplate,
  deleteTemplate,
  runJobs,
};
