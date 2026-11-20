import httpStatus from "http-status";
import catchAsync from "../../helpers/catchAsync";
import { Request, Response } from "express";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { InquiryService } from "./inquiry.service";
import { InquiryStatusService } from "./inquiry.status.service";

// Create an inquiry by hand (phone, email). 409 with the likely duplicate
// customers when the person may already be a relation.
const createInquiry = catchAsync(async (req: Request, res: Response) => {
  // Only these fields are taken from the request. In particular `external_ref`
  // is for automated senders and is never accepted from here.
  const fields = pickValidFields(req.body, [
    "relation_id",
    "relation_type",
    "company_name",
    "contact_name",
    "contact_email",
    "contact_phone",
    "service_type",
    "description",
    "address",
    "language",
    "assigned_to",
    "allow_duplicate_relation",
    "send_confirmation",
  ]);

  const result = await InquiryService.createInquiry(
    { ...fields, source: req.body.source ?? "OTHER" },
    req.user.id,
  );

  if (!result.created && result.reason === "duplicates") {
    return sendResponse(res, {
      statusCode: httpStatus.CONFLICT,
      success: false,
      message:
        "Possible duplicate customers found! Pick an existing relation (relation_id), or resend with allow_duplicate_relation: true to create a new one.",
      data: { duplicates: result.duplicates },
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Inquiry created successfully",
    data: (result as any).inquiry,
  });
});

const getAllInquiries = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryService.getAllInquiries(req.query, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Inquiries fetched successfully",
    data: result.data,
    meta: result.meta,
  });
});

const getPipeline = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryService.getPipeline(req.query, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Pipeline fetched successfully",
    data: result,
  });
});

const getSummary = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryService.getSummary();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Inquiry summary fetched successfully",
    data: result,
  });
});

const getOptions = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryService.getOptions();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Inquiry options fetched successfully",
    data: result,
  });
});

// Opening an inquiry marks it as seen (clears the "new" highlight)
const getInquiryById = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryService.getInquiryById(
    req.params.id as string,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Inquiry fetched successfully",
    data: result,
  });
});

const updateInquiry = catchAsync(async (req: Request, res: Response) => {
  const fields = pickValidFields(req.body, [
    "relation_id",
    "service_type",
    "description",
    "contact_name",
    "contact_email",
    "contact_phone",
    "address",
    "language",
    "assigned_to",
  ]);
  const result = await InquiryService.updateInquiry(
    req.params.id as string,
    fields,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Inquiry updated successfully",
    data: result,
  });
});

const changeStatus = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryService.changeStatus(
    req.params.id as string,
    { status: req.body.status, lost_reason: req.body.lost_reason },
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Inquiry status updated successfully",
    data: result,
  });
});

const addPhotos = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryService.addPhotos(
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

const deletePhoto = catchAsync(async (req: Request, res: Response) => {
  await InquiryService.deletePhoto(
    req.params.id as string,
    req.params.photoId as string,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "File deleted successfully",
    data: null,
  });
});

const addNote = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryService.addNote(
    req.params.id as string,
    req.body.note,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Note added successfully",
    data: result,
  });
});

const getHistory = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryService.getHistory(
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

// Statuses (configurable by the Beheerder)
const getStatuses = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryStatusService.getStatuses();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Statuses fetched successfully",
    data: result,
  });
});

const createStatus = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryStatusService.createStatus(req.body, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Status created successfully",
    data: result,
  });
});

const updateStatus = catchAsync(async (req: Request, res: Response) => {
  const result = await InquiryStatusService.updateStatus(
    req.params.statusId as string,
    pickValidFields(req.body, [
      "label_nl",
      "label_en",
      "color",
      "sort_order",
      "is_active",
    ]),
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Status updated successfully",
    data: result,
  });
});

const deleteStatus = catchAsync(async (req: Request, res: Response) => {
  await InquiryStatusService.deleteStatus(
    req.params.statusId as string,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Status deleted successfully",
    data: null,
  });
});

export const InquiryController = {
  createInquiry,
  getAllInquiries,
  getPipeline,
  getSummary,
  getOptions,
  getInquiryById,
  updateInquiry,
  changeStatus,
  addPhotos,
  deletePhoto,
  addNote,
  getHistory,
  getStatuses,
  createStatus,
  updateStatus,
  deleteStatus,
};
