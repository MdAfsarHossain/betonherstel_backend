import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { SubcontractorUserService } from "../portal/portal.users.service";
import { SubPortalService } from "./subportal.service";

const ok = (res: Response, message: string, data: any, meta?: any) =>
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message,
    data,
    ...(meta ? { meta } : {}),
  });
const created = (res: Response, message: string, data: any) =>
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message,
    data,
  });
const id = (req: Request) => req.params.id as string;
const files = (req: Request) => (req.files as Express.Multer.File[]) ?? [];

// ---------------------------------------------------------------- subcontractor

const getMe = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Profile fetched successfully",
    await SubPortalService.getMe(req.user.id),
  ),
);
const updateMe = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Profile updated successfully",
    await SubPortalService.updateMe(
      req.user.id,
      pickValidFields(req.body, [
        "name",
        "phone_number",
        "preferred_language",
      ]) as any,
    ),
  ),
);
const updateCompany = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Company details updated successfully",
    await SubPortalService.updateCompany(
      req.user.id,
      pickValidFields(req.body, ["phone", "email"]) as any,
    ),
  ),
);
const getHome = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Home fetched successfully",
    await SubPortalService.getHome(req.user.id),
  ),
);

const getAssignments = catchAsync(async (req: Request, res: Response) => {
  const r = await SubPortalService.getAssignments(req.user.id, req.query);
  ok(res, "Assignments fetched successfully", r.data, r.meta);
});
const getAssignmentById = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Assignment fetched successfully",
    await SubPortalService.getAssignmentById(req.user.id, id(req)),
  ),
);
const getAssignmentPdf = catchAsync(async (req: Request, res: Response) => {
  const { pdf, filename } = await SubPortalService.getAssignmentPdf(
    req.user.id,
    id(req),
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(pdf);
});
const respond = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Your answer has been recorded",
    await SubPortalService.respond(
      req.user.id,
      id(req),
      pickValidFields(req.body, [
        "response",
        "comment",
        "proposed_start",
        "proposed_end",
      ]) as any,
    ),
  ),
);
const reportProgress = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Progress recorded successfully",
    await SubPortalService.reportProgress(
      req.user.id,
      id(req),
      pickValidFields(req.body, ["percent", "note"]) as any,
    ),
  ),
);
const complete = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Assignment marked as complete",
    await SubPortalService.complete(req.user.id, id(req), req.body.note),
  ),
);
const addFiles = catchAsync(async (req: Request, res: Response) =>
  created(
    res,
    "Files uploaded successfully",
    await SubPortalService.addFiles(
      req.user.id,
      id(req),
      files(req),
      req.body ?? {},
    ),
  ),
);
const deleteFile = catchAsync(async (req: Request, res: Response) => {
  await SubPortalService.deleteFile(
    req.user.id,
    id(req),
    req.params.fileId as string,
  );
  ok(res, "File deleted successfully", null);
});

const getInvoices = catchAsync(async (req: Request, res: Response) => {
  const r = await SubPortalService.getInvoices(req.user.id, req.query);
  ok(res, "Invoices fetched successfully", r.data, r.meta);
});
const getInvoiceById = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Invoice fetched successfully",
    await SubPortalService.getInvoiceById(req.user.id, id(req)),
  ),
);
const uploadInvoice = catchAsync(async (req: Request, res: Response) =>
  created(
    res,
    "Invoice uploaded successfully",
    await SubPortalService.uploadInvoice(
      req.user.id,
      id(req),
      req.body ?? {},
      files(req),
    ),
  ),
);
const replaceInvoiceFile = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Document replaced successfully",
    await SubPortalService.replaceInvoiceFile(req.user.id, id(req), files(req)),
  ),
);
const getInvoiceFile = catchAsync(async (req: Request, res: Response) => {
  const file = await SubPortalService.getInvoiceFile(req.user.id, id(req));
  res.setHeader("Content-Type", file.mime);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${file.name.replace(/"/g, "")}"`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(file.data);
});

// ---------------------------------------------------------------- office

const inviteUser = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractorUserService.inviteUser(
    pickValidFields(req.body, [
      "relation_id",
      "contact_id",
      "name",
      "email",
      "phone_number",
      "language",
    ]) as any,
    req.user.id,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: result.invitation.sent
      ? "Invitation sent successfully"
      : "Portal user created, but the invitation email could not be delivered. Send it again!",
    data: result,
  });
});
const getUsers = catchAsync(async (req: Request, res: Response) => {
  const r = await SubcontractorUserService.getUsers(req.query);
  ok(res, "Portal users fetched successfully", r.data, r.meta);
});
const getUserById = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Portal user fetched successfully",
    await SubcontractorUserService.getUserById(id(req)),
  ),
);
const updateUser = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Portal user updated successfully",
    await SubcontractorUserService.updateUser(
      id(req),
      pickValidFields(req.body, [
        "is_active",
        "name",
        "phone_number",
        "language",
      ]) as any,
      req.user.id,
    ),
  ),
);
const resendInvitation = catchAsync(async (req: Request, res: Response) => {
  const result = await SubcontractorUserService.resendInvitation(
    id(req),
    req.user.id,
  );
  ok(
    res,
    result.invitation.sent
      ? "Invitation sent successfully"
      : "The invitation email could not be delivered. Try again later!",
    result,
  );
});
export const SubPortalController = {
  getMe,
  updateMe,
  updateCompany,
  getHome,
  getAssignments,
  getAssignmentById,
  getAssignmentPdf,
  respond,
  reportProgress,
  complete,
  addFiles,
  deleteFile,
  getInvoices,
  getInvoiceById,
  uploadInvoice,
  replaceInvoiceFile,
  getInvoiceFile,
};

export const SubPortalAdminController = {
  inviteUser,
  getUsers,
  getUserById,
  updateUser,
  resendInvitation,
};
