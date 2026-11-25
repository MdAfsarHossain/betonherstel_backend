import { Server } from "http";
import app, { isAllowedOrigin } from "./app";
import config from "./config";
import cron from "node-cron";
import seedSuperAdmin from "./app/seedSuperAdmin";
import {
  setUserOnline,
  setUserOffline,
  isUserOnline,
} from "./app/lib/socketManager";
import { initDatabase } from "./config/database";
import { query } from "./app/utils/db";
import { jwtHelpers } from "./app/helpers/jwtHelpers";
import { Secret } from "jsonwebtoken";
import { QuoteJobs } from "./app/modules/quote/quote.jobs";
import { attachRealtime } from "./app/lib/realtime";
import { ActionJobs } from "./app/modules/actions/actions.jobs";
import { ContractJobs } from "./app/modules/contract/contract.jobs";
import { SnelStartSyncService } from "./app/modules/snelstart/snelstart.sync.service";
import { InvoiceDeliveryService } from "./app/modules/invoice/invoice.delivery.service";

const port = config.port || 5000;

// A promise nobody handled (e.g. a failed email) must be logged, never take the server down
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled promise rejection:", reason);
});

// interface ExtendedWebSocket extends WebSocket {
//   roomId?: string;
//   userId?: string;
// }

async function main() {
  // Initialize database tables
  // await initDatabase();

  const server: Server = app.listen(port, () => {
    console.log("Server is running on port ", port);
    console.log(`🚀 Server running on http://localhost:${port}`);
    console.log(`📝 API Documentation: http://localhost:${port}/api/v1`);
  });
  // seedSuperAdmin();

  // Live updates (a native WebSocket at /ws on the same port): notifications and the project chat
  attachRealtime(server, isAllowedOrigin);

  // =========================
  // START CRON JOBS
  // =========================

  startCronJobs();
}

function startCronJobs() {
  // Quotations: expire the ones past their validity date, and send follow-up
  // reminders (FR-QUO-09, FR-QUO-12). Amsterdam time, so "morning" is the office's morning.
  cron.schedule(
    "5 0 * * *",
    async () => {
      const expired = await QuoteJobs.expireOverdueQuotes().catch(
        (error: any) => {
          console.error("❌ Quotation expiry job failed:", error);
          return 0;
        },
      );
      if (expired > 0) console.log(`✅ ${expired} quotation(s) expired`);
    },
    { timezone: "Europe/Amsterdam" },
  );

  cron.schedule(
    "0 8 * * 1-5",
    async () => {
      const reminded = await QuoteJobs.sendFollowUpReminders().catch(
        (error: any) => {
          console.error("❌ Quotation follow-up job failed:", error);
          return 0;
        },
      );
      if (reminded > 0)
        console.log(`✅ ${reminded} quotation follow-up reminder(s) sent`);
    },
    { timezone: "Europe/Amsterdam" },
  );

  // Invoices: payment reminders for overdue invoices, at the steps in the settings (FR-INV-11)
  cron.schedule(
    "0 9 * * *",
    async () => {
      const reminded = await InvoiceDeliveryService.sendDueReminders().catch(
        (error: any) => {
          console.error("❌ Invoice reminder job failed:", error);
          return 0;
        },
      );
      if (reminded > 0)
        console.log(`✅ ${reminded} invoice payment reminder(s) sent`);
    },
    { timezone: "Europe/Amsterdam" },
  );

  // Tasks (FR-MSG-04): automatic tasks for unanswered quotations and overdue invoices, and
  // closing the ones that are no longer needed. Amsterdam time, before the office starts.
  cron.schedule(
    "30 7 * * *",
    async () => {
      const result = await ActionJobs.runScheduledJobs().catch((error: any) => {
        console.error("❌ Action job failed:", error);
        return null;
      });
      if (result)
        console.log(
          `✅ Actions: ${result.quote_follow_ups} quote follow-up(s), ${result.overdue_invoices} overdue invoice(s), ${result.closed} closed`,
        );
    },
    { timezone: "Europe/Amsterdam" },
  );

  // Maintenance contracts (FR-ABO-02, FR-ABO-06): bill the contracts whose billing date has come and
  // plan the coming maintenance visits. Amsterdam time, before the office starts.
  cron.schedule(
    "0 6 * * *",
    async () => {
      const result = await ContractJobs.runScheduledJobs().catch(
        (error: any) => {
          console.error("❌ Subscription job failed:", error);
          return null;
        },
      );
      if (result)
        console.log(
          `✅ Subscriptions: ${result.billed} billed, ${result.ended} ended, ${result.failed} failed, ${result.visits_planned} visit(s) planned`,
        );
    },
    { timezone: "Europe/Amsterdam" },
  );

  // SnelStart (FR-SNEL-06): SnelStart has no webhooks, so we look every minute whether the configured interval
  // (default 15 minutes) has passed, then send what is queued and read back what was settled
  cron.schedule("* * * * *", async () => {
    const result = await SnelStartSyncService.runIfDue().catch((error: any) => {
      console.error("❌ SnelStart sync failed:", error?.message ?? error);
      return null;
    });
    if (result?.ran)
      console.log(
        `✅ SnelStart: ${result.sent} sent, ${result.failed} failed, ${result.retrying} to retry, ${result.settled} settled`,
      );
  });

  console.log(
    "Cron jobs scheduled: quotation expiry (00:05) and follow-ups (08:00, Mon-Fri)",
  );
  console.log("Cron jobs scheduled: automatic tasks (07:30)");
  console.log("Cron jobs scheduled: subscription billing and visits (06:00)");
  console.log("Cron jobs scheduled: invoice payment reminders (09:00)");
}

main();
