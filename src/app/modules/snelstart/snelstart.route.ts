import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { SnelStartController } from "./snelstart.controller";
import { SnelStartValidation } from "./snelstart.validation";

// Permission matrix (SRS 3.2, "SnelStart sync log"): the Beheerder configures, Kantoor can view and retry,
// the field crew have no access. Static paths come before "/:id".
const route = Router();
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");
const admin = auth("SUPERADMIN", "ADMIN");

// Connection and settings (Beheerder)
route.get("/", staff, SnelStartController.getStatus);
route.put(
  "/connection",
  admin,
  validateRequest(SnelStartValidation.connect),
  SnelStartController.connect,
);
route.post("/connection/test", admin, SnelStartController.testConnection);
route.delete("/connection", admin, SnelStartController.disconnect);
route.put(
  "/settings",
  admin,
  validateRequest(SnelStartValidation.updateSettings),
  SnelStartController.updateSettings,
);

// Mapping of VAT codes and categories to SnelStart (Beheerder changes, Kantoor looks)
route.get("/ledgers", admin, SnelStartController.getLedgers);
route.get("/vat-rates", admin, SnelStartController.getVatRates);
route.get("/mapping", staff, SnelStartController.getMapping);
route.put(
  "/mapping/vat",
  admin,
  validateRequest(SnelStartValidation.vatMapping),
  SnelStartController.setVatMapping,
);
route.put(
  "/mapping/ledgers",
  admin,
  validateRequest(SnelStartValidation.ledgerMapping),
  SnelStartController.setLedgerMapping,
);
route.delete(
  "/mapping/ledgers/:id",
  admin,
  SnelStartController.deleteLedgerMapping,
);

// The synchronisation, the queue and the log
route.post("/sync/run", staff, SnelStartController.runSync);
route.get("/queue", staff, SnelStartController.getQueue);
route.post("/queue/retry-failed", staff, SnelStartController.retryAllFailed);
route.post(
  "/queue/backfill",
  admin,
  validateRequest(SnelStartValidation.backfill),
  SnelStartController.backfill,
);
route.get("/queue/:id", staff, SnelStartController.getItem);
route.post("/queue/:id/retry", staff, SnelStartController.retryItem);
route.post(
  "/queue/:id/skip",
  admin,
  validateRequest(SnelStartValidation.skip),
  SnelStartController.skipItem,
);
route.get("/log", staff, SnelStartController.getLog);

export const SnelStartRoutes = route;
