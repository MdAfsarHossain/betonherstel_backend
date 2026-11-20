import { Router } from "express";
import auth from "../../middlewares/auth";
import { fileUploader } from "../../middlewares/multerFileUpload";
import validateRequest from "../../middlewares/validateRequest";
import { SupplierInvoiceController } from "./supplierinvoice.controller";
import { SupplierInvoiceValidation } from "./supplierinvoice.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) have full access to purchasing; field crew have none
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");

// Overview and exports (static routes before "/:id")
route.get("/overview", staff, SupplierInvoiceController.getOverview);
route.get("/export", staff, SupplierInvoiceController.exportCsv);
route.get("/export/files", staff, SupplierInvoiceController.exportFiles);

route.post("/", staff, validateRequest(SupplierInvoiceValidation.createSupplierInvoice), SupplierInvoiceController.createSupplierInvoice);
route.get("/", staff, SupplierInvoiceController.getAllSupplierInvoices);

route.get("/:id", staff, SupplierInvoiceController.getSupplierInvoiceById);
route.patch("/:id", staff, validateRequest(SupplierInvoiceValidation.updateSupplierInvoice), SupplierInvoiceController.updateSupplierInvoice);

// The supplier's own document (PDF or photo)
route.post("/:id/file", staff, fileUploader.files, SupplierInvoiceController.uploadFile);
route.get("/:id/file", staff, SupplierInvoiceController.getFile);

// Ontvangen -> Goedgekeurd -> Betaald
route.post("/:id/approve", staff, SupplierInvoiceController.approve);
route.post("/:id/unapprove", staff, SupplierInvoiceController.unapprove);
route.post("/:id/pay", staff, validateRequest(SupplierInvoiceValidation.paySupplierInvoice), SupplierInvoiceController.pay);
route.post("/:id/void", staff, validateRequest(SupplierInvoiceValidation.voidSupplierInvoice), SupplierInvoiceController.voidInvoice);

route.get("/:id/history", staff, SupplierInvoiceController.getHistory);

export const SupplierInvoiceRoute = route;
