import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { CatalogueController } from "./catalogue.controller";
import { CatalogueValidation } from "./catalogue.validation";
const route = Router();

// Admin and office staff read the catalogue to build quotations; only an admin
// changes it (FR-SET-04). Field crew have no access (no prices).
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");
const admin = auth("SUPERADMIN", "ADMIN");

route.get("/", staff, CatalogueController.getAllCatalogueItems);

route.post(
  "/",
  admin,
  validateRequest(CatalogueValidation.createCatalogueItem),
  CatalogueController.createCatalogueItem,
);

route.get("/:id", staff, CatalogueController.getCatalogueItemById);

route.patch(
  "/:id",
  admin,
  validateRequest(CatalogueValidation.updateCatalogueItem),
  CatalogueController.updateCatalogueItem,
);

export const CatalogueRoute = route;
