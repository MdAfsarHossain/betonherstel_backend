import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { CatalogueService } from "./catalogue.service";

const catalogueItemFields = [
  "code",
  "name",
  "description",
  "type",
  "unit",
  "unit_price",
  "cost_price",
  "vat_code",
  "service_type",
] as const;

const getAllCatalogueItems = catchAsync(async (req: Request, res: Response) => {
  const result = await CatalogueService.getAllCatalogueItems(req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Catalogue items fetched successfully",
    data: result.data,
    meta: result.meta,
  });
});

const getCatalogueItemById = catchAsync(async (req: Request, res: Response) => {
  const result = await CatalogueService.getCatalogueItemById(req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Catalogue item fetched successfully",
    data: result,
  });
});

const createCatalogueItem = catchAsync(async (req: Request, res: Response) => {
  const result = await CatalogueService.createCatalogueItem(
    pickValidFields(req.body, [...catalogueItemFields]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Catalogue item created successfully",
    data: result,
  });
});

const updateCatalogueItem = catchAsync(async (req: Request, res: Response) => {
  const result = await CatalogueService.updateCatalogueItem(
    req.params.id as string,
    pickValidFields(req.body, [...catalogueItemFields, "is_active"]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Catalogue item updated successfully",
    data: result,
  });
});

export const CatalogueController = {
  getAllCatalogueItems,
  getCatalogueItemById,
  createCatalogueItem,
  updateCatalogueItem,
};
