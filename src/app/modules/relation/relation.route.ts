import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { RelationController } from "./relation.controller";
import { RelationValidation } from "./relation.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) have full access to Relaties.
// Field crew (FIELD) get a restricted, job-scoped view once Projects exist.
// Static paths must stay before "/:id".
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");

// CSV export is a bulk dump of personal data: Beheerder only
route.get(
  "/export",
  auth("SUPERADMIN", "ADMIN"),
  RelationController.exportRelations,
);

route.post(
  "/check-duplicates",
  staff,
  validateRequest(RelationValidation.checkDuplicates),
  RelationController.checkDuplicates,
);

route.post(
  "/",
  staff,
  validateRequest(RelationValidation.createRelation),
  RelationController.createRelation,
);

route.get("/", staff, RelationController.getAllRelations);

route.get("/:id", staff, RelationController.getRelationById);

route.patch(
  "/:id",
  staff,
  validateRequest(RelationValidation.updateRelation),
  RelationController.updateRelation,
);

// Contact persons
route.post(
  "/:id/contacts",
  staff,
  validateRequest(RelationValidation.createContact),
  RelationController.createContact,
);

route.patch(
  "/:id/contacts/:contactId",
  staff,
  validateRequest(RelationValidation.updateContact),
  RelationController.updateContact,
);

route.delete(
  "/:id/contacts/:contactId",
  staff,
  RelationController.deleteContact,
);

// Object addresses (work locations)
route.post(
  "/:id/addresses",
  staff,
  validateRequest(RelationValidation.createAddress),
  RelationController.createAddress,
);

route.patch(
  "/:id/addresses/:addressId",
  staff,
  validateRequest(RelationValidation.updateAddress),
  RelationController.updateAddress,
);

route.delete(
  "/:id/addresses/:addressId",
  staff,
  RelationController.deleteAddress,
);

// Notes and timeline
route.post(
  "/:id/notes",
  staff,
  validateRequest(RelationValidation.createNote),
  RelationController.addNote,
);

route.get("/:id/timeline", staff, RelationController.getTimeline);

export const RelationRoute = route;
