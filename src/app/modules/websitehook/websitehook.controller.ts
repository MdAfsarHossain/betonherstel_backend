import { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import { WebsiteHookService } from "./websitehook.service";

const origin = (req: Request) => `${req.protocol}://${req.get("host")}`;
const ok = (res: Response, message: string, data: any, meta?: any) =>
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message, data, meta });

// Public endpoint: authenticated by the secret, answers in the sender's terms
const receive = async (req: Request, res: Response) => {
  try {
    const result = await WebsiteHookService.receive({
      headers: req.headers,
      body: req.body,
      rawBody: (req as any).rawBody ?? Buffer.from(""),
      ip: req.ip,
      contentType: req.headers["content-type"],
    });
    res.status(result.httpStatus).json({ statusCode: result.httpStatus, ...result.body });
  } catch (error: any) {
    console.error("❌ Website webhook crashed:", error?.message ?? error);
    res.status(500).json({ success: false, message: "Something went wrong, please try again later!" });
  }
};

const parseError = async (error: any, req: Request, res: Response, next: NextFunction) => {
  const status = Number(error?.status ?? error?.statusCode) || 400;
  if (status >= 500) return next(error);
  await WebsiteHookService.logRefused(req.ip, req.headers["content-type"], status, error?.type === "entity.too.large" ? "Body is too large" : "Body could not be read");
  res.status(status).json({ success: false, statusCode: status, message: status === 413 ? "The request is too large!" : "The request body could not be read!" });
};

const getSettings = catchAsync(async (req: Request, res: Response) => ok(res, "Webhook settings fetched successfully", await WebsiteHookService.getSettings(origin(req))));
const updateSettings = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Webhook settings updated successfully", await WebsiteHookService.updateSettings(req.body, req.user.id, origin(req))),
);
const regenerateSecret = catchAsync(async (req: Request, res: Response) => ok(res, "Secret generated successfully", await WebsiteHookService.regenerateSecret(req.user.id)));
const testMapping = catchAsync(async (req: Request, res: Response) => ok(res, "Mapping tested successfully", await WebsiteHookService.testMapping(req.body.payload)));
const getLogs = catchAsync(async (req: Request, res: Response) => {
  const r = await WebsiteHookService.getLogs(req.query);
  ok(res, "Webhook log fetched successfully", r.data, r.meta);
});
const getLogById = catchAsync(async (req: Request, res: Response) => ok(res, "Log entry fetched successfully", await WebsiteHookService.getLogById(req.params.id as string)));
const getExample = catchAsync(async (req: Request, res: Response) => ok(res, "Webhook example fetched successfully", WebsiteHookService.getExample(origin(req))));

export const WebsiteHookController = { receive, parseError, getSettings, updateSettings, regenerateSecret, testMapping, getLogs, getLogById, getExample };
