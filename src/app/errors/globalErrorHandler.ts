import { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import { ZodError } from "zod";
import config from "../../config";
import handleZodError from "./handleZodError";
import { IGenericErrorMessage } from "../interface/error";
import ApiError from "./ApiError";

const isProduction = () => config.env === "production";

// Database errors that mean "the request was wrong", by SQLSTATE
const postgresClientErrors: Record<string, { status: number; message: string }> = {
  "23505": { status: httpStatus.CONFLICT, message: "This value already exists!" },
  "23503": { status: httpStatus.CONFLICT, message: "This record is linked to other data, or refers to something that does not exist!" },
  "23502": { status: httpStatus.BAD_REQUEST, message: "A required value is missing!" },
  "23514": { status: httpStatus.BAD_REQUEST, message: "A value is not allowed!" },
  "22P02": { status: httpStatus.BAD_REQUEST, message: "A value has the wrong format!" },
  "22001": { status: httpStatus.BAD_REQUEST, message: "A value is too long!" },
  "22003": { status: httpStatus.BAD_REQUEST, message: "A number is out of range!" },
  "22007": { status: httpStatus.BAD_REQUEST, message: "A date or time has the wrong format!" },
  "22008": { status: httpStatus.BAD_REQUEST, message: "A date or time is out of range!" },
  "22021": { status: httpStatus.BAD_REQUEST, message: "A value contains characters that are not allowed!" },
  "22P05": { status: httpStatus.BAD_REQUEST, message: "A value contains characters that are not allowed!" },
};

// Connection-level database failures (restart, network, pool exhausted), not mistakes in the request
const isDatabaseUnavailable = (error: any) =>
  ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "EAI_AGAIN"].includes(error?.code) ||
  ["57P01", "57P02", "57P03", "53300", "08000", "08001", "08003", "08004", "08006"].includes(error?.code) ||
  /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|Connection error/i.test(String(error?.message ?? ""));

const snelstartStatus: Record<string, number> = {
  NOT_CONFIGURED: httpStatus.CONFLICT,
  VALIDATION: httpStatus.BAD_REQUEST,
  TEMPORARY: httpStatus.SERVICE_UNAVAILABLE,
  RATE_LIMIT: httpStatus.SERVICE_UNAVAILABLE,
};

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

  // Errors from body-parser and other http-errors (malformed JSON, unsupported charset, ...): the
  // client's mistake with its own 4xx status, not a crash
  else if (
    typeof (error?.status ?? error?.statusCode) === "number" &&
    (error.status ?? error.statusCode) >= 400 &&
    (error.status ?? error.statusCode) < 500 &&
    error.expose !== false &&
    !(typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code))
  ) {
    statusCode = error.status ?? error.statusCode;
    message =
      error.type === "entity.parse.failed"
        ? "The request body is not valid JSON!"
        : statusCode === httpStatus.REQUEST_ENTITY_TOO_LARGE
          ? "The request is too large!"
          : error.message;
    errorMessages = [{ path: "", message }];
  }

  // A broken multipart upload (busboy: malformed part header, unexpected end of form, ...): the client's mistake
  else if (error instanceof Error && /busboy|multer/.test(String(error.stack ?? "").split("\n").slice(0, 6).join("\n"))) {
    statusCode = httpStatus.BAD_REQUEST;
    message = "The upload is not a valid form!";
    errorMessages = [{ path: "", message }];
  }

  // The database (or its connection) is unavailable: tell clients and load balancers to retry later (503)
  else if (isDatabaseUnavailable(error)) {
    statusCode = httpStatus.SERVICE_UNAVAILABLE;
    message = "The service is temporarily unavailable. Please try again in a moment!";
    errorMessages = [{ path: "", message }];
  }

  // PostgreSQL constraint and type errors caused by the request: a 4xx with a generic message, never
  // the database's own text (table, column and row details)
  else if (typeof error?.code === "string" && postgresClientErrors[error.code]) {
    const mapped = postgresClientErrors[error.code];
    statusCode = mapped.status;
    message = mapped.message;
    errorMessages = [{ path: "", message }];
  }

  // SnelStart integration errors: "not connected" and bad mapping are the admin's to fix, not a crash
  else if (error?.constructor?.name === "SnelStartError" && snelstartStatus[error.kind]) {
    statusCode = snelstartStatus[error.kind];
    message = error.message;
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

  // A crash must not tell the client about the database, file paths or code: log it here, answer generically
  if (statusCode >= 500 && !(error instanceof ApiError)) {
    console.error("❌ Unhandled error on", req.method, req.originalUrl, error);
    if (isProduction()) {
      message = "Something went wrong!";
      errorMessages = [{ path: "", message }];
    }
  }

  res.status(statusCode).json({
    success: false,
    message,
    errorMessages,
    // The raw error object (SQL details, stack) is for development only
    err: isProduction() ? { statusCode } : error,
    stack: !isProduction() ? error?.stack : undefined,
  });
};

export default GlobalErrorHandler;
