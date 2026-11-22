import { Request, Response } from "express";
import httpStatus from "http-status";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import { SnelStartSettingsService } from "./snelstart.settings.service";
import { SnelStartSyncService } from "./snelstart.sync.service";

const ok = (res: Response, message: string, data: any, meta?: any) => sendResponse(res, { statusCode: httpStatus.OK, success: true, message, data, ...(meta ? { meta } : {}) });
const id = (req: Request) => req.params.id as string;

const getStatus = catchAsync(async (req: Request, res: Response) => ok(res, "SnelStart status fetched successfully", await SnelStartSettingsService.getStatus()));
const connect = catchAsync(async (req: Request, res: Response) => ok(res, "SnelStart connected successfully", await SnelStartSettingsService.connect(req.body, req.user.id)));
const testConnection = catchAsync(async (req: Request, res: Response) => ok(res, "SnelStart connection checked", await SnelStartSettingsService.testConnection()));
const disconnect = catchAsync(async (req: Request, res: Response) => ok(res, "SnelStart disconnected successfully", await SnelStartSettingsService.disconnect(req.user.id)));
const updateSettings = catchAsync(async (req: Request, res: Response) =>
  ok(res, "SnelStart settings updated successfully", await SnelStartSettingsService.updateSettings({ is_enabled: req.body.is_enabled, sync_interval_minutes: req.body.sync_interval_minutes }, req.user.id)),
);
const getLedgers = catchAsync(async (req: Request, res: Response) => ok(res, "Ledger accounts fetched from SnelStart", await SnelStartSettingsService.listLedgers(String(req.query.include_inactive) === "true")));
const getVatRates = catchAsync(async (req: Request, res: Response) => ok(res, "VAT rates fetched from SnelStart", await SnelStartSettingsService.listVatRates()));
const getMapping = catchAsync(async (req: Request, res: Response) => ok(res, "Mapping fetched successfully", await SnelStartSettingsService.getMapping()));
const setVatMapping = catchAsync(async (req: Request, res: Response) => ok(res, "VAT mapping saved successfully", await SnelStartSettingsService.setVatMapping(req.body.items, req.user.id)));
const setLedgerMapping = catchAsync(async (req: Request, res: Response) => ok(res, "Ledger mapping saved successfully", await SnelStartSettingsService.setLedgerMapping(req.body.items, req.user.id)));
const deleteLedgerMapping = catchAsync(async (req: Request, res: Response) => ok(res, "Ledger mapping removed successfully", await SnelStartSettingsService.deleteLedgerMapping(id(req), req.user.id)));

const runSync = catchAsync(async (req: Request, res: Response) => ok(res, "Synchronisation ran", await SnelStartSyncService.runSync({ force: true })));
const getQueue = catchAsync(async (req: Request, res: Response) => {
  const r = await SnelStartSyncService.getQueue(req.query);
  ok(res, "Queue fetched successfully", r.data, r.meta);
});
const getItem = catchAsync(async (req: Request, res: Response) => ok(res, "Queue item fetched successfully", await SnelStartSyncService.getItem(id(req))));
const retryItem = catchAsync(async (req: Request, res: Response) => ok(res, "Record put back in the queue", await SnelStartSyncService.retryItem(id(req), req.user.id)));
const retryAllFailed = catchAsync(async (req: Request, res: Response) => ok(res, "Failed records put back in the queue", await SnelStartSyncService.retryAllFailed(req.user.id)));
const skipItem = catchAsync(async (req: Request, res: Response) => ok(res, "Record skipped", await SnelStartSyncService.skipItem(id(req), req.body.reason, req.user.id)));
const backfill = catchAsync(async (req: Request, res: Response) => ok(res, "Records queued", await SnelStartSyncService.backfill(req.body, req.user.id)));
const getLog = catchAsync(async (req: Request, res: Response) => {
  const r = await SnelStartSyncService.getLog(req.query);
  ok(res, "Log fetched successfully", r.data, r.meta);
});

export const SnelStartController = {
  getStatus, connect, testConnection, disconnect, updateSettings, getLedgers, getVatRates, getMapping, setVatMapping, setLedgerMapping, deleteLedgerMapping,
  runSync, getQueue, getItem, retryItem, retryAllFailed, skipItem, backfill, getLog,
};
