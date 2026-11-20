import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { ContractController } from "./contract.controller";
import { ContractValidation } from "./contract.validation";

// Beheerder and Kantoor: Abonnementen are Full / Full / None in the permission matrix. Static
// paths must stay before "/:id".
const route = Router();
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");
const admin = auth("SUPERADMIN", "ADMIN");

route.get("/summary", staff, ContractController.getSummary);
route.post(
  "/jobs/run",
  admin,
  validateRequest(ContractValidation.runJobs),
  ContractController.runJobs,
);

// Direct debit (SEPA mandate through Mollie), per customer
route.get(
  "/direct-debit/:relationId",
  staff,
  ContractController.getDirectDebit,
);
route.post(
  "/direct-debit/:relationId/start",
  staff,
  validateRequest(ContractValidation.startDirectDebit),
  ContractController.startDirectDebit,
);
route.post(
  "/direct-debit/:relationId/sync",
  staff,
  ContractController.syncDirectDebit,
);
route.delete(
  "/direct-debit/:relationId",
  staff,
  ContractController.revokeDirectDebit,
);

route.post(
  "/",
  staff,
  validateRequest(ContractValidation.createContract),
  ContractController.createContract,
);
route.get("/", staff, ContractController.getAll);
route.get("/:id", staff, ContractController.getById);
route.patch(
  "/:id",
  staff,
  validateRequest(ContractValidation.updateContract),
  ContractController.updateContract,
);
route.post("/:id/pause", staff, ContractController.pauseContract);
route.post("/:id/resume", staff, ContractController.resumeContract);
route.post(
  "/:id/end",
  staff,
  validateRequest(ContractValidation.endContract),
  ContractController.endContract,
);
route.get("/:id/invoices", staff, ContractController.getInvoices);
route.get("/:id/history", staff, ContractController.getHistory);

export const ContractRoute = route;
