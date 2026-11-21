import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { PlanningController } from "./planning.controller";
import { PlanningValidation } from "./planning.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) have full access to planning. Field crew
// (FIELD) may only view their own schedule (permission matrix, section 3.2).
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");
const anyEmployee = auth("SUPERADMIN", "ADMIN", "OFFICE", "FIELD");

// Own schedule on the phone, and the calendar subscription link
route.get("/my-schedule", anyEmployee, PlanningController.getMySchedule);
// "I'm finished": the crew marks their OWN appointment as done (nothing else about it)
route.post(
  "/my-schedule/:id/done",
  anyEmployee,
  validateRequest(PlanningValidation.completeMine),
  PlanningController.completeMyAppointment,
);

route.post("/ical-token", anyEmployee, PlanningController.createIcalToken);
route.get("/ical-token", anyEmployee, PlanningController.getIcalTokenInfo);
route.delete("/ical-token", anyEmployee, PlanningController.revokeIcalToken);

// The calendar feed itself is public: calendar apps cannot log in, the secret in the URL is the key
// Works with or without the ".ics" ending: calendar apps like it, Postman users forget it
route.get("/ical/:token", PlanningController.getIcalFeed);

// Calendar views
route.get("/employees", staff, PlanningController.getEmployees);
route.get("/resources", staff, PlanningController.getResourceView);
route.get("/appointments", staff, PlanningController.getAppointments);

// Warn about double-booking while dragging, before saving
route.post(
  "/check-conflicts",
  staff,
  validateRequest(PlanningValidation.checkConflicts),
  PlanningController.checkConflicts,
);

route.post(
  "/appointments",
  staff,
  validateRequest(PlanningValidation.createAppointment),
  PlanningController.createAppointment,
);

route.get("/appointments/:id", staff, PlanningController.getAppointmentById);

route.patch(
  "/appointments/:id",
  staff,
  validateRequest(PlanningValidation.updateAppointment),
  PlanningController.updateAppointment,
);

route.post(
  "/appointments/:id/status",
  staff,
  validateRequest(PlanningValidation.changeStatus),
  PlanningController.changeStatus,
);

route.post(
  "/appointments/:id/send-confirmation",
  staff,
  validateRequest(PlanningValidation.sendConfirmation),
  PlanningController.sendConfirmation,
);

route.delete("/appointments/:id", staff, PlanningController.deleteAppointment);

export const PlanningRoute = route;
