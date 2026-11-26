import { Router } from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { PurchaseOrderController } from "./purchaseorder.controller";
import { PurchaseOrderValidation } from "./purchaseorder.validation";
const route = Router();

// Beheerder (ADMIN) and Kantoor (OFFICE) have full access to purchasing; field crew have
// none (permission matrix, section 3.2). Suppliers never log in: they get the order by email.
const staff = auth("SUPERADMIN", "ADMIN", "OFFICE");

route.post(
  "/",
  staff,
  validateRequest(PurchaseOrderValidation.createPurchaseOrder),
  PurchaseOrderController.createPurchaseOrder,
);
route.get("/", staff, PurchaseOrderController.getAllPurchaseOrders);

route.get("/:id", staff, PurchaseOrderController.getPurchaseOrderById);
route.patch(
  "/:id",
  staff,
  validateRequest(PurchaseOrderValidation.updatePurchaseOrder),
  PurchaseOrderController.updatePurchaseOrder,
);
route.put(
  "/:id/lines",
  staff,
  validateRequest(PurchaseOrderValidation.setLines),
  PurchaseOrderController.setLines,
);
route.delete("/:id", staff, PurchaseOrderController.deletePurchaseOrder);

// Placing the order gives it its number and PDF; sending emails it to the supplier
route.post(
  "/:id/order",
  staff,
  validateRequest(PurchaseOrderValidation.orderPurchaseOrder),
  PurchaseOrderController.orderPurchaseOrder,
);
route.post(
  "/:id/send",
  staff,
  validateRequest(PurchaseOrderValidation.sendPurchaseOrder),
  PurchaseOrderController.sendPurchaseOrder,
);
route.get("/:id/pdf", staff, PurchaseOrderController.getPdf);

route.post(
  "/:id/receive",
  staff,
  validateRequest(PurchaseOrderValidation.receiveGoods),
  PurchaseOrderController.receiveGoods,
);
route.post(
  "/:id/cancel",
  staff,
  validateRequest(PurchaseOrderValidation.cancelPurchaseOrder),
  PurchaseOrderController.cancelPurchaseOrder,
);

route.get("/:id/history", staff, PurchaseOrderController.getHistory);

export const PurchaseOrderRoute = route;
