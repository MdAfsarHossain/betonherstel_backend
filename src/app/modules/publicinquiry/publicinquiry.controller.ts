import { Request, Response } from "express";
import httpStatus from "http-status";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import { PublicInquiryService } from "./publicinquiry.service";

// Public: no login. Answers with the reference only, never internal ids or other customers' data.
const createInquiry = catchAsync(async (req: Request, res: Response) => {
  const result = await PublicInquiryService.createInquiry(
    req.body,
    ((req.files as Express.Multer.File[]) ?? []).filter(Boolean),
    req.ip,
  );

  sendResponse(res, {
    statusCode: result.created ? httpStatus.CREATED : httpStatus.OK,
    success: true,
    message: result.created
      ? "Your request has been received. We will contact you soon!"
      : "Your request was already received. Thank you!",
    data: {
      reference: result.reference,
      ...("photos_added" in result
        ? {
            photos_added: result.photos_added,
            photos_error: result.photos_error,
          }
        : {}),
    },
  });
});

export const PublicInquiryController = { createInquiry };
