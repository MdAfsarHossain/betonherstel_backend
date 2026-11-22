import { Request, Response } from "express";
import httpStatus from "http-status";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import { MollieService } from "../../lib/mollie";
import { SettingsService } from "./settings.service";

const getCompany = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.getCompanySettings();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Company settings fetched successfully",
    data: result,
  });
});

const updateCompany = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.updateCompanySettings(req.body, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Company settings updated successfully",
    data: result,
  });
});

const updateLogo = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.updateCompanyLogo(req.file, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Logo updated successfully",
    data: result,
  });
});

const getEmailTemplates = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.getEmailTemplates();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Email templates fetched successfully",
    data: result,
  });
});

const getEmailTemplate = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.getEmailTemplate(
    req.params.key as string,
    req.params.language as string,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Email template fetched successfully",
    data: result,
  });
});

const updateEmailTemplate = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.updateEmailTemplate(
    req.params.key as string,
    req.params.language as string,
    req.body,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Email template updated successfully",
    data: result,
  });
});

const resetEmailTemplate = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.resetEmailTemplate(
    req.params.key as string,
    req.params.language as string,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Email template reset to default",
    data: result,
  });
});

const getAuditLog = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.getAuditLog(req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Audit log fetched successfully",
    data: result.data,
    meta: result.meta,
  });
});

const previewPdf = catchAsync(async (req: Request, res: Response) => {
  const pdf = await SettingsService.previewPdf(req.query.language as string);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="preview.pdf"');
  res.status(httpStatus.OK).send(pdf);
});

const getServiceTypes = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.getServiceTypes();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Service types fetched successfully",
    data: result,
  });
});

const createServiceType = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.createServiceType(req.body, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Service type created successfully",
    data: result,
  });
});

const updateServiceType = catchAsync(async (req: Request, res: Response) => {
  const result = await SettingsService.updateServiceType(
    req.params.id as string,
    req.body,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Service type updated successfully",
    data: result,
  });
});

// Mollie connection (FR-SET-05): the key is saved encrypted and never sent back
const getMollie = catchAsync(async (req: Request, res: Response) => {
  const result = await MollieService.getStatus();

  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Mollie status fetched successfully", data: result });
});

const saveMollie = catchAsync(async (req: Request, res: Response) => {
  const result = await MollieService.saveKey(req.body.api_key, req.user.id);

  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Mollie connected successfully", data: result });
});

const removeMollie = catchAsync(async (req: Request, res: Response) => {
  const result = await MollieService.removeKey(req.user.id);

  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Mollie disconnected", data: result });
});

const testMollie = catchAsync(async (req: Request, res: Response) => {
  const result = await MollieService.testConnection();

  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Mollie connection works", data: result });
});

export const SettingsController = {
  getServiceTypes,
  createServiceType,
  updateServiceType,
  getCompany,
  updateCompany,
  updateLogo,
  getEmailTemplates,
  getEmailTemplate,
  updateEmailTemplate,
  resetEmailTemplate,
  getAuditLog,
  previewPdf,
  getMollie,
  saveMollie,
  removeMollie,
  testMollie,
};
