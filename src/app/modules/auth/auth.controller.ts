import httpStatus from "http-status";
import sendResponse from "../../helpers/sendResponse";
import { Request, Response } from "express";
import catchAsync from "../../helpers/catchAsync";
import { AuthServices } from "./auth.service";
import { TwoFactorService } from "./auth.twoFactor.service";

const loginUser = catchAsync(async (req: Request, res: Response) => {
  const { email, password, fcm_token } = req.body;

  const result: any = await AuthServices.loginUserFromDB(
    email,
    password,
    fcm_token,
  );

  // The password was right but a second step is needed before there is a session
  const message = result.twoFactorRequired
    ? "Enter the code from your authenticator app"
    : result.twoFactorSetupRequired
      ? "Two-factor authentication setup is required"
      : "Login successful";

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message,
    data: result,
  });
});

const refreshToken = catchAsync(async (req: Request, res: Response) => {
  const result = await AuthServices.refreshToken(req.body.refreshToken);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Token refreshed successfully",
    data: result,
  });
});

const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const result = await AuthServices.forgotPassword(req.body);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.message,
    data: null,
  });
});

const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const result = await AuthServices.resetPassword(
    req.body.token,
    req.body.newPassword,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: "Password Reset successfully please login",
    data: result,
  });
});

const changePassword = catchAsync(async (req, res) => {
  const userId: string = req.user.id;
  const oldPassword: string = req.body.oldPassword;
  const newPassword: string = req.body.newPassword;

  const result = await AuthServices.changePassword(userId, {
    newPassword,
    oldPassword,
  });

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: "Password changed successfully! ",
    data: result,
  });
});

// Two-factor authentication
const twoFactorSetup = catchAsync(async (req: Request, res: Response) => {
  const result = await TwoFactorService.setup(req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message:
      "Add the secret to your authenticator app, then confirm with a code",
    data: result,
  });
});

const twoFactorEnable = catchAsync(async (req: Request, res: Response) => {
  const result = await TwoFactorService.enable(
    req.user.id,
    req.body.code,
    Boolean(req.user.viaSetupToken),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message:
      "Two-factor authentication enabled. Store your recovery codes safely!",
    data: result,
  });
});

const twoFactorVerifyLogin = catchAsync(async (req: Request, res: Response) => {
  const { twoFactorToken, code, recoveryCode } = req.body;
  const result = await TwoFactorService.verifyLogin(twoFactorToken, {
    code,
    recoveryCode,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Login successful",
    data: result,
  });
});

const twoFactorDisable = catchAsync(async (req: Request, res: Response) => {
  const result = await TwoFactorService.disable(
    req.user.id,
    req.body.password,
    req.body.code,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.message,
    data: null,
  });
});

export const AuthControllers = {
  loginUser,
  refreshToken,
  forgotPassword,
  resetPassword,
  changePassword,
  twoFactorSetup,
  twoFactorEnable,
  twoFactorVerifyLogin,
  twoFactorDisable,
};
