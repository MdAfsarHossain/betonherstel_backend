import httpStatus from "http-status";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { ProjectService } from "./project.service";
import { ProjectStatusService } from "./project.status.service";

const headerFields = [
  "title",
  "description",
  "service_type",
  "address",
  "planned_start",
  "planned_end",
  "contact_name",
  "contact_email",
  "contact_phone",
  "project_manager_id",
  "internal_notes",
] as const;

const lineFields = [
  "section_title",
  "catalogue_item_id",
  "description",
  "quantity",
  "unit",
  "unit_price",
  "cost_price",
  "vat_code",
] as const;

const createProject = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.createProject(
    pickValidFields(req.body, ["quote_id", "relation_id", ...headerFields, "sections"]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Project created successfully",
    data: result,
  });
});

const getAllProjects = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.getAllProjects(req.query, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Projects fetched successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getSummary = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.getSummary();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Project summary fetched successfully",
    data: result,
  });
});

const getProjectById = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.getProjectById(req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Project fetched successfully",
    data: result,
  });
});

const updateProject = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.updateProject(
    req.params.id as string,
    pickValidFields(req.body, [...headerFields]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Project updated successfully",
    data: result,
  });
});

const deleteProject = catchAsync(async (req: Request, res: Response) => {
  await ProjectService.deleteProject(req.params.id as string, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Project deleted successfully",
    data: null,
  });
});

const changeStatus = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.changeStatus(
    req.params.id as string,
    { status: req.body.status, note: req.body.note },
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Project status updated successfully",
    data: result,
  });
});

const setBudget = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.setBudget(req.params.id as string, req.body.sections, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Budget saved successfully",
    data: result,
  });
});

const getFinancials = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.getFinancials(req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Financial overview fetched successfully",
    data: result,
  });
});

const addAdditionalWork = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.addAdditionalWork(
    req.params.id as string,
    pickValidFields(req.body, [...lineFields]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Additional work added successfully",
    data: result,
  });
});

const updateAdditionalWork = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.updateAdditionalWork(
    req.params.id as string,
    req.params.lineId as string,
    pickValidFields(req.body, lineFields.filter((f) => f !== "catalogue_item_id")) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Additional work updated successfully",
    data: result,
  });
});

const deleteAdditionalWork = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.deleteAdditionalWork(
    req.params.id as string,
    req.params.lineId as string,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Additional work deleted successfully",
    data: result,
  });
});

const addFiles = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.addFiles(
    req.params.id as string,
    (req.files as Express.Multer.File[]) ?? [],
    req.body ?? {},
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Files uploaded successfully",
    data: result,
  });
});

const getFiles = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.getFiles(req.params.id as string, req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Files fetched successfully",
    data: result,
  });
});

const updateFile = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.updateFile(
    req.params.id as string,
    req.params.fileId as string,
    pickValidFields(req.body, ["folder", "caption", "share_with_customer", "share_with_subcontractor"]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "File updated successfully",
    data: result,
  });
});

const deleteFile = catchAsync(async (req: Request, res: Response) => {
  await ProjectService.deleteFile(req.params.id as string, req.params.fileId as string, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "File deleted successfully",
    data: null,
  });
});

const getMyProjects = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.getMyProjects(req.user.id, req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Projects fetched successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getMyProjectById = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.getMyProjectById(req.user.id, req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Project fetched successfully",
    data: result,
  });
});

const getHistory = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectService.getHistory(req.params.id as string, req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "History fetched successfully",
    meta: result.meta,
    data: result.data,
  });
});

// Statuses
const getStatuses = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectStatusService.getStatuses(String(req.query.active_only) === "true");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Statuses fetched successfully",
    data: result,
  });
});

const createStatus = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectStatusService.createStatus(
    pickValidFields(req.body, ["label_nl", "label_en", "kind", "color", "sort_order"]) as any,
    req.user.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Status created successfully",
    data: result,
  });
});

const updateStatus = catchAsync(async (req: Request, res: Response) => {
  const result = await ProjectStatusService.updateStatus(
    req.params.statusId as string,
    pickValidFields(req.body, ["label_nl", "label_en", "color", "sort_order", "is_active"]) as any,
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
  await ProjectStatusService.deleteStatus(req.params.statusId as string, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Status deleted successfully",
    data: null,
  });
});

export const ProjectController = {
  createProject,
  getAllProjects,
  getSummary,
  getProjectById,
  updateProject,
  deleteProject,
  changeStatus,
  setBudget,
  getFinancials,
  addAdditionalWork,
  updateAdditionalWork,
  deleteAdditionalWork,
  addFiles,
  getFiles,
  updateFile,
  deleteFile,
  getMyProjects,
  getMyProjectById,
  getHistory,
  getStatuses,
  createStatus,
  updateStatus,
  deleteStatus,
};
