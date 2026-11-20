import httpStatus from "http-status";
import catchAsync from "../../helpers/catchAsync";
import { Request, Response } from "express";
import sendResponse from "../../helpers/sendResponse";
import { RelationService } from "./relation.service";

// Create relation (409 with the likely duplicates when any exist)
const createRelation = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.createRelation(req.body, req.user.id);

  if (!result.created) {
    return sendResponse(res, {
      statusCode: httpStatus.CONFLICT,
      success: false,
      message:
        "Possible duplicate relations found! Open an existing relation, or resend with allow_duplicate: true to create anyway.",
      data: { duplicates: result.duplicates },
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Relation created successfully",
    data: result.relation,
  });
});

// Check for duplicates without creating anything
const checkDuplicates = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.findDuplicates(req.body);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message:
      result.length > 0
        ? "Possible duplicate relations found"
        : "No duplicate relations found",
    data: result,
  });
});

// All relations (search, filter, paginate)
const getAllRelations = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.getAllRelations(req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Relations fetched successfully",
    data: result.data,
    meta: result.meta,
  });
});

// CSV export (Beheerder only)
const exportRelations = catchAsync(async (req: Request, res: Response) => {
  const csv = await RelationService.exportRelationsCsv(req.query);
  const date = new Date().toISOString().slice(0, 10);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="relaties-${date}.csv"`,
  );
  res.status(httpStatus.OK).send(csv);
});

// Single relation with contacts and addresses
const getRelationById = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.getRelationById(req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Relation fetched successfully",
    data: result,
  });
});

// Update relation (also used to deactivate / reactivate)
const updateRelation = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.updateRelation(
    req.params.id as string,
    req.body,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Relation updated successfully",
    data: result,
  });
});

// Contact persons
const createContact = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.createContact(
    req.params.id as string,
    req.body,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Contact created successfully",
    data: result,
  });
});

const updateContact = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.updateContact(
    req.params.id as string,
    req.params.contactId as string,
    req.body,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Contact updated successfully",
    data: result,
  });
});

const deleteContact = catchAsync(async (req: Request, res: Response) => {
  await RelationService.deleteContact(
    req.params.id as string,
    req.params.contactId as string,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Contact deleted successfully",
    data: null,
  });
});

// Object addresses
const createAddress = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.createAddress(
    req.params.id as string,
    req.body,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Address created successfully",
    data: result,
  });
});

const updateAddress = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.updateAddress(
    req.params.id as string,
    req.params.addressId as string,
    req.body,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Address updated successfully",
    data: result,
  });
});

const deleteAddress = catchAsync(async (req: Request, res: Response) => {
  await RelationService.deleteAddress(
    req.params.id as string,
    req.params.addressId as string,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Address deleted successfully",
    data: null,
  });
});

// Notes and timeline
const addNote = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.addNote(
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

const getTimeline = catchAsync(async (req: Request, res: Response) => {
  const result = await RelationService.getTimeline(
    req.params.id as string,
    req.query,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Timeline fetched successfully",
    data: result.data,
    meta: result.meta,
  });
});

export const RelationController = {
  createRelation,
  checkDuplicates,
  getAllRelations,
  exportRelations,
  getRelationById,
  updateRelation,
  createContact,
  updateContact,
  deleteContact,
  createAddress,
  updateAddress,
  deleteAddress,
  addNote,
  getTimeline,
};
