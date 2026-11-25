import { Request, Response } from "express";
import httpStatus from "http-status";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import { AdminService } from "./admin.service";

// All users
const allUsers = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminService.allUsers(req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Users fetched successfully",
    data: result.data,
    meta: result.meta,
  });
});

// Customers' portal accounts
const allCustomers = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminService.allCustomers(req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Customers fetched successfully",
    data: result.data,
    meta: result.meta,
  });
});

// Employees: admin, office and field crew
const allStaff = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminService.allStaff(req.query);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff fetched successfully",
    data: result.data,
    meta: result.meta,
  });
});

// Single user
const getUserById = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminService.getUserById(req.params.id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User fetched successfully",
    data: result,
  });
});

// Create internal user
const createUser = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminService.createUser(req.body, req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "User created successfully",
    data: result,
  });
});

// Update another user (role, status, deactivate)
const updateUserByAdmin = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminService.updateUserByAdmin(
    { id: req.user.id, role: req.user.role },
    req.params.id as string,
    req.body,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User updated successfully",
    data: result,
  });
});

// Reset a user's two-factor authentication
const resetTwoFactor = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminService.resetTwoFactor(
    { id: req.user.id, role: req.user.role },
    req.params.id as string,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.message,
    data: null,
  });
});

export const AdminController = {
  resetTwoFactor,
  allUsers,
  allCustomers,
  allStaff,
  getUserById,
  createUser,
  updateUserByAdmin,
};
