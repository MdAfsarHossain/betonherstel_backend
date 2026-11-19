import { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import { ZodError } from "zod";
import config from "../../config";
import handleZodError from "./handleZodError";
import { IGenericErrorMessage } from "../interface/error";
import ApiError from "./ApiError";

const GlobalErrorHandler = (
  error: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  let statusCode: any = httpStatus.INTERNAL_SERVER_ERROR;
  let message = error.message || "Something went wrong!";
  let errorMessages: IGenericErrorMessage[] = [];

  // Handle Zod Validation Errors
  //   else
  if (error instanceof ZodError) {
    const simplifiedError = handleZodError(error);
    statusCode = simplifiedError.statusCode;
    message = simplifiedError.message;
    errorMessages = simplifiedError.errorMessages;
  }

  // Handle Custom ApiError
  else if (error instanceof ApiError) {
    statusCode = error?.statusCode;
    message = error.message;
    errorMessages = error?.message
      ? [
          {
            path: "",
            message: error?.message,
          },
        ]
      : [];
  }

  // Handle jsonwebtoken's own error classes (thrown directly by jwt.verify,
  // not wrapped in ApiError) — these are auth failures and must map to 401,
  // not the generic 500 the plain `instanceof Error` branch below would give
  // them. Without this, expired/invalid tokens are indistinguishable from a
  // server crash to any client trying to detect "should refresh the token".
  else if (
    error?.name === "TokenExpiredError" ||
    error?.name === "JsonWebTokenError" ||
    error?.name === "NotBeforeError"
  ) {
    statusCode = httpStatus.UNAUTHORIZED;
    message = error.message;
    errorMessages = [
      {
        path: "",
        message: error.message,
      },
    ];
  }

  // Handle file upload limits (multer): a bad upload is the client's mistake, not a crash
  else if (error?.name === "MulterError") {
    statusCode = httpStatus.BAD_REQUEST;
    message =
      error.code === "LIMIT_FILE_SIZE"
        ? "The file is too large (maximum 10 MB)!"
        : error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE"
          ? "Too many files, or an unexpected file field!"
          : error.message;
    errorMessages = [{ path: error.field ?? "", message }];
  }

  // A request body over the size limit (body-parser): the client's mistake, not a crash
  else if (error?.type === "entity.too.large") {
    statusCode = httpStatus.REQUEST_ENTITY_TOO_LARGE;
    message = "The request is too large!";
    errorMessages = [{ path: "", message }];
  }

  // Handle Errors
  else if (error instanceof Error) {
    message = error?.message;
    errorMessages = error?.message
      ? [
          {
            path: "",
            message: error?.message,
          },
        ]
      : [];
  }

  // Generic Error Handling (e.g., JavaScript Errors)
  else if (error instanceof SyntaxError) {
    statusCode = httpStatus.BAD_REQUEST;
    message = "Syntax error in the request. Please verify your input.";
    errorMessages = [
      {
        path: "",
        message: "Syntax Error",
      },
    ];
  } else if (error instanceof TypeError) {
    statusCode = httpStatus.BAD_REQUEST;
    message = "Type error in the application. Please verify your input.";
    errorMessages = [
      {
        path: "",
        message: "Type Error",
      },
    ];
  } else if (error instanceof ReferenceError) {
    statusCode = httpStatus.BAD_REQUEST;
    message = "Reference error in the application. Please verify your input.";
    errorMessages = [
      {
        path: "",
        message: "Reference Error",
      },
    ];
  }
  // Catch any other error type
  else {
    message = "An unexpected error occurred!";
    errorMessages = [
      {
        path: "",
        message: "An unexpected error occurred!",
      },
    ];
  }

  res.status(statusCode).json({
    success: false,
    message,
    errorMessages,
    err: error,
    stack: config.env !== "production" ? error?.stack : undefined,
  });
};

export default GlobalErrorHandler;
