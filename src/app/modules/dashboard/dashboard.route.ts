import { Router } from "express";
import auth from "../../middlewares/auth";
import { DashboardController } from "./dashboard.controller";
const route = Router();

// Beheerder and Kantoor get the office dashboard (only the Beheerder sees the money totals and the
// SnelStart warning); Uitvoerder gets the simplified day view. The service picks by role.
route.get("/", auth("SUPERADMIN", "ADMIN", "OFFICE", "FIELD"), DashboardController.getDashboard);

// The full recent-events feed (the dashboard shows the latest 10): the office only
route.get("/events", auth("SUPERADMIN", "ADMIN", "OFFICE"), DashboardController.getRecentEvents);

export const DashboardRoute = route;
