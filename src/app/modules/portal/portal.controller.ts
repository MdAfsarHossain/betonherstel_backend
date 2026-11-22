import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { PortalService } from "./portal.service";
import { PortalUserService } from "./portal.users.service";

const ok = (res: Response, message: string, data: any, meta?: any) =>
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message,
    data,
    ...(meta ? { meta } : {}),
  });

const sendPdf = (res: Response, pdf: Buffer, filename: string) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(httpStatus.OK).send(pdf);
};

const id = (req: Request) => req.params.id as string;

// ---------------------------------------------------------------- customer

const getBranding = catchAsync(async (_req: Request, res: Response) =>
  ok(res, "Branding fetched successfully", await PortalService.getBranding()),
);
const getMe = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Profile fetched successfully",
    await PortalService.getMe(req.user.id),
  ),
);
const updateMe = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Profile updated successfully",
    await PortalService.updateMe(
      req.user.id,
      pickValidFields(req.body, [
        "name",
        "phone_number",
        "preferred_language",
      ]) as any,
    ),
  ),
);
const getHome = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Home fetched successfully",
    await PortalService.getHome(req.user.id),
  ),
);

const getQuotes = catchAsync(async (req: Request, res: Response) => {
  const r = await PortalService.getQuotes(req.user.id, req.query);
  ok(res, "Quotations fetched successfully", r.data, r.meta);
});
const getQuoteById = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Quotation fetched successfully",
    await PortalService.getQuoteById(req.user.id, id(req)),
  ),
);
const getQuotePdf = catchAsync(async (req: Request, res: Response) => {
  const { pdf, filename } = await PortalService.getQuotePdf(
    req.user.id,
    id(req),
  );
  sendPdf(res, pdf, filename);
});
const acceptQuote = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Quotation accepted successfully",
    await PortalService.acceptQuote(
      req.user.id,
      id(req),
      pickValidFields(req.body, ["terms_accepted", "accepted_by_name"]) as any,
      req.ip,
    ),
  ),
);
const rejectQuote = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Quotation rejected",
    await PortalService.rejectQuote(req.user.id, id(req), req.body.reason),
  ),
);

const getProjects = catchAsync(async (req: Request, res: Response) => {
  const r = await PortalService.getProjects(req.user.id, req.query);
  ok(res, "Projects fetched successfully", r.data, r.meta);
});
const getProjectById = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Project fetched successfully",
    await PortalService.getProjectById(req.user.id, id(req)),
  ),
);
const getWorkOrderPdf = catchAsync(async (req: Request, res: Response) => {
  const { pdf, filename } = await PortalService.getWorkOrderPdf(
    req.user.id,
    id(req),
  );
  sendPdf(res, pdf, filename);
});
const getAppointments = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Appointments fetched successfully",
    await PortalService.getAppointments(req.user.id, req.query),
  ),
);

const getInvoices = catchAsync(async (req: Request, res: Response) => {
  const r = await PortalService.getInvoices(req.user.id, req.query);
  res.status(httpStatus.OK).json({
    success: true,
    statusCode: httpStatus.OK,
    message: "Invoices fetched successfully",
    meta: r.meta,
    totals: r.totals,
    data: r.data,
  });
});
const getInvoiceById = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Invoice fetched successfully",
    await PortalService.getInvoiceById(req.user.id, id(req)),
  ),
);
const getInvoicePdf = catchAsync(async (req: Request, res: Response) => {
  const { pdf, filename } = await PortalService.getInvoicePdf(
    req.user.id,
    id(req),
  );
  sendPdf(res, pdf, filename);
});
const payInvoice = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Payment started successfully",
    await PortalService.payInvoice(req.user.id, id(req)),
  ),
);

const getSubscriptions = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Maintenance contracts fetched successfully",
    await PortalService.getSubscriptions(req.user.id),
  ),
);
const getDirectDebit = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Direct debit status fetched successfully",
    await PortalService.getDirectDebit(req.user.id),
  ),
);
const startDirectDebit = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Direct debit authorisation started successfully",
    await PortalService.startDirectDebit(req.user.id),
  ),
);

const createInquiry = catchAsync(async (req: Request, res: Response) =>
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Your request has been sent successfully",
    data: await PortalService.createInquiry(
      req.user.id,
      pickValidFields(req.body, [
        "description",
        "service_type",
        "address",
        "contact_phone",
      ]) as any,
    ),
  }),
);
const getInquiries = catchAsync(async (req: Request, res: Response) => {
  const r = await PortalService.getInquiries(req.user.id, req.query);
  ok(res, "Requests fetched successfully", r.data, r.meta);
});
const getInquiryById = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Request fetched successfully",
    await PortalService.getInquiryById(req.user.id, id(req)),
  ),
);
const updateInquiry = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Request updated successfully",
    await PortalService.updateInquiry(
      req.user.id,
      id(req),
      pickValidFields(req.body, [
        "description",
        "service_type",
        "address",
        "contact_phone",
      ]) as any,
    ),
  ),
);
const addInquiryPhotos = catchAsync(async (req: Request, res: Response) =>
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Photos uploaded successfully",
    data: await PortalService.addInquiryPhotos(
      req.user.id,
      id(req),
      (req.files as Express.Multer.File[]) ?? [],
    ),
  }),
);

// ---------------------------------------------------------------- office

const inviteUser = catchAsync(async (req: Request, res: Response) => {
  const result = await PortalUserService.inviteUser(
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
  const r = await PortalUserService.getUsers(req.query);
  ok(res, "Portal users fetched successfully", r.data, r.meta);
});
const getUserById = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Portal user fetched successfully",
    await PortalUserService.getUserById(id(req)),
  ),
);
const updateUser = catchAsync(async (req: Request, res: Response) =>
  ok(
    res,
    "Portal user updated successfully",
    await PortalUserService.updateUser(
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
  const result = await PortalUserService.resendInvitation(id(req), req.user.id);
  ok(
    res,
    result.invitation.sent
      ? "Invitation sent successfully"
      : "The invitation email could not be delivered. Try again later!",
    result,
  );
});

export const PortalController = {
  getBranding,
  getMe,
  updateMe,
  getHome,
  getQuotes,
  getQuoteById,
  getQuotePdf,
  acceptQuote,
  rejectQuote,
  getProjects,
  getProjectById,
  getWorkOrderPdf,
  getAppointments,
  getInvoices,
  getInvoiceById,
  getInvoicePdf,
  payInvoice,
  getSubscriptions,
  getDirectDebit,
  startDirectDebit,
  createInquiry,
  getInquiries,
  getInquiryById,
  updateInquiry,
  addInquiryPhotos,
};

export const PortalAdminController = {
  inviteUser,
  getUsers,
  getUserById,
  updateUser,
  resendInvitation,
};
