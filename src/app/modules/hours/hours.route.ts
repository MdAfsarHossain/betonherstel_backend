import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { HoursController } from "./hours.controller";
import { HoursValidation } from "./hours.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) have full access and approve hours. Field crew
// (FIELD) log and view their own hours (permission matrix, section 3.2). The service also
// keeps each person to their own entries.
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");
const admin = auth("SUPERADMIN", "ADMIN");
const anyEmployee = auth("SUPERADMIN", "ADMIN", "OFFICE", "FIELD");

// Own hours, the projects to book on, the timer (static routes before "/:id")
route.get("/my", anyEmployee, HoursController.getMyEntries);
route.get("/projects", anyEmployee, HoursController.getBookableProjects);
route.get("/timer", anyEmployee, HoursController.getTimer);
route.post(
  "/timer/start",
  anyEmployee,
  validateRequest(HoursValidation.startTimer),
  HoursController.startTimer,
);
route.post(
  "/timer/stop",
  anyEmployee,
  validateRequest(HoursValidation.stopTimer),
  HoursController.stopTimer,
);
route.delete("/timer", anyEmployee, HoursController.discardTimer);

// Office: weekly overview, approval, export, rates, hours for invoices
route.get("/week", staff, HoursController.getWeek);
route.post(
  "/approve",
  staff,
  validateRequest(HoursValidation.approve),
  HoursController.approve,
);
route.get("/export", staff, HoursController.exportCsv);
route.get("/billable/:projectId", staff, HoursController.getBillable);
route.get("/rates", staff, HoursController.getRates);
route.get("/rates/:userId", staff, HoursController.getRateHistory);
route.put(
  "/rates/:userId",
  admin,
  validateRequest(HoursValidation.setRate),
  HoursController.setRate,
);

// Registering and correcting hours
route.post(
  "/",
  anyEmployee,
  validateRequest(HoursValidation.createEntry),
  HoursController.createEntry,
);
route.get("/", staff, HoursController.getAllEntries);
route.patch(
  "/:id",
  anyEmployee,
  validateRequest(HoursValidation.updateEntry),
  HoursController.updateEntry,
);
route.delete("/:id", anyEmployee, HoursController.deleteEntry);
route.post(
  "/:id/reject",
  staff,
  validateRequest(HoursValidation.reject),
  HoursController.rejectEntry,
);
route.post(
  "/:id/unapprove",
  staff,
  validateRequest(HoursValidation.unapprove),
  HoursController.unapproveEntry,
);

export const HoursRoute = route;
