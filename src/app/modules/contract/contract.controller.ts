import { Request, Response } from "express";
import httpStatus from "http-status";
import catchAsync from "../../helpers/catchAsync";
import sendResponse from "../../helpers/sendResponse";
import pickValidFields from "../../shared/pickValidFields";
import { DirectDebitService } from "./contract.directdebit.service";
import { ContractJobs } from "./contract.jobs";
import { ContractService } from "./contract.service";

const id = (req: Request) => req.params.id as string;
const ok = (res: Response, message: string, data: any, meta?: any, statusCode: number = httpStatus.OK) =>
  sendResponse(res, { statusCode, success: true, message, data, meta });

const contractFields = [
  "title", "description", "address", "amount_excl_vat", "vat_code", "billing_interval", "end_date",
  "payment_term_days", "use_direct_debit", "language", "visits_per_year", "first_visit_date", "visit_assignee_ids", "internal_notes",
] as const;

const createContract = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Maintenance contract created successfully",
    await ContractService.createContract({ ...pickValidFields(req.body, [...contractFields, "relation_id", "start_date"]) } as any, req.user.id), undefined, httpStatus.CREATED),
);
const getAll = catchAsync(async (req: Request, res: Response) => {
  const r = await ContractService.getAll(req.query);
  ok(res, "Maintenance contracts fetched successfully", r.data, r.meta);
});
const getSummary = catchAsync(async (req: Request, res: Response) => ok(res, "Summary fetched successfully", await ContractService.getSummary()));
const getById = catchAsync(async (req: Request, res: Response) => ok(res, "Maintenance contract fetched successfully", await ContractService.getById(id(req))));
const updateContract = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Maintenance contract updated successfully", await ContractService.updateContract(id(req), pickValidFields(req.body, [...contractFields]) as any, req.user.id)),
);
const pauseContract = catchAsync(async (req: Request, res: Response) => ok(res, "Maintenance contract paused successfully", await ContractService.pauseContract(id(req), req.user.id)));
const resumeContract = catchAsync(async (req: Request, res: Response) => ok(res, "Maintenance contract resumed successfully", await ContractService.resumeContract(id(req), req.user.id)));
const endContract = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Maintenance contract ended successfully", await ContractService.endContract(id(req), pickValidFields(req.body, ["end_date", "reason"]) as any, req.user.id)),
);
const getInvoices = catchAsync(async (req: Request, res: Response) => ok(res, "Invoices fetched successfully", await ContractService.getInvoices(id(req))));
const getHistory = catchAsync(async (req: Request, res: Response) => {
  const r = await ContractService.getHistory(id(req), req.query);
  ok(res, "History fetched successfully", r.data, r.meta);
});

// Direct debit, per customer
const relationId = (req: Request) => req.params.relationId as string;
const getDirectDebit = catchAsync(async (req: Request, res: Response) => ok(res, "Direct debit status fetched successfully", await DirectDebitService.getStatus(relationId(req))));
const startDirectDebit = catchAsync(async (req: Request, res: Response) =>
  ok(res, "Direct debit authorisation started successfully",
    await DirectDebitService.startSetup(relationId(req), { via: "OFFICE", actorId: req.user.id, sendEmail: req.body?.send_email === true })),
);
const syncDirectDebit = catchAsync(async (req: Request, res: Response) => ok(res, "Direct debit status updated successfully", await DirectDebitService.syncSetup(relationId(req))));
const revokeDirectDebit = catchAsync(async (req: Request, res: Response) => ok(res, "Direct debit mandate removed successfully", await DirectDebitService.revoke(relationId(req), req.user.id)));

const runJobs = catchAsync(async (req: Request, res: Response) => {
  const result = req.body?.subscription_id ? await ContractJobs.runBilling(req.body.subscription_id) : await ContractJobs.runScheduledJobs();
  ok(res, "Jobs ran successfully", result);
});

export const ContractController = {
  createContract, getAll, getSummary, getById, updateContract, pauseContract, resumeContract, endContract, getInvoices, getHistory,
  getDirectDebit, startDirectDebit, syncDirectDebit, revokeDirectDebit, runJobs,
};
