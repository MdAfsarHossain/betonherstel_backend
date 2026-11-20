import { Request, Response } from "express";
// import { WebhooksService } from "./webhooks.service";
import ApiError from "../../errors/ApiError";
import { InvoicePaymentService } from "../invoice/invoice.payment.service";

// Mollie webhook (FR-INV-09): Mollie posts only a payment id; the payment itself is read from
// Mollie. Always answers 200 for anything Mollie should not retry (unknown payment, a key
// that does not match); a real failure answers 500 so Mollie tries again later.
const molliePaymentWebhook = async (req: Request, res: Response) => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  try {
    await InvoicePaymentService.handleMollieWebhook(id);
    res.status(200).send("OK");
  } catch (error: any) {
    if (
      error instanceof ApiError &&
      (error.statusCode === 404 || error.statusCode === 409)
    ) {
      res.status(200).send("IGNORED");
      return;
    }
    console.error("❌ Mollie webhook failed:", error?.message ?? error);
    res.status(500).send("ERROR");
  }
};

export const WebhookController = {
  molliePaymentWebhook,
};
