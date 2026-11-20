import express from "express";
import { AuthRouters } from "../modules/auth/auth.routes";
import { UserRoute } from "../modules/user/user.route";
// import { WebhookRoute } from "../modules/webhooks/webhook.route";
import { AdminRoutes } from "../modules/admin/admin.route";
import { RelationRoute } from "../modules/relation/relation.route";
import { SettingsRoute } from "../modules/settings/settings.route";
import { InquiryRoute } from "../modules/inquiry/inquiry.route";
import { QuoteRoute } from "../modules/quote/quote.route";
import { CatalogueRoute } from "../modules/catalogue/catalogue.route";
import { PlanningRoute } from "../modules/planning/planning.route";
import { ProjectRoute } from "../modules/project/project.route";
import { WorkOrderRoute } from "../modules/workorder/workorder.route";
import { HoursRoute } from "../modules/hours/hours.route";
import { InvoiceRoute } from "../modules/invoice/invoice.route";
import { PurchaseOrderRoute } from "../modules/purchasing/purchaseorder.route";
import { SupplierInvoiceRoute } from "../modules/purchasing/supplierinvoice.route";
import { SubcontractingRoute } from "../modules/subcontracting/subcontracting.route";
import { ActionRoute } from "../modules/actions/actions.route";
import { MessageRoute } from "../modules/messages/message.route";
import { NotificationRoute } from "../modules/messages/notification.route";
import { DashboardRoute } from "../modules/dashboard/dashboard.route";
import { PortalRoute } from "../modules/portal/portal.route";
import { PortalAdminRoute } from "../modules/portal/portaladmin.route";
import { SubPortalRoute } from "../modules/subportal/subportal.route";
import { SubPortalAdminRoute } from "../modules/subportal/subportaladmin.route";
import { SnelStartRoutes } from "../modules/snelstart/snelstart.route";
import { ContractRoute } from "../modules/contract/contract.route";
import { WebsiteHookRoute } from "../modules/websitehook/websitehook.route";
import { ChatRoutes } from "../modules/chat/chat.route";

const router = express.Router();

const moduleRoutes = [
  {
    path: "/auth",
    route: AuthRouters,
  },
  {
    path: "/user",
    route: UserRoute,
  },
  // {
  //   path: "/webhooks",
  //   route: WebhookRoute,
  // },
  {
    path: "/admin",
    route: AdminRoutes,
  },
  {
    path: "/relations",
    route: RelationRoute,
  },
  {
    path: "/settings",
    route: SettingsRoute,
  },
  {
    path: "/inquiries",
    route: InquiryRoute,
  },
  {
    path: "/quotes",
    route: QuoteRoute,
  },
  {
    path: "/catalogue",
    route: CatalogueRoute,
  },
  {
    path: "/planning",
    route: PlanningRoute,
  },
  {
    path: "/projects",
    route: ProjectRoute,
  },
  {
    path: "/work-orders",
    route: WorkOrderRoute,
  },
  {
    path: "/hours",
    route: HoursRoute,
  },
  {
    path: "/invoices",
    route: InvoiceRoute,
  },
  {
    path: "/purchase-orders",
    route: PurchaseOrderRoute,
  },
  {
    path: "/supplier-invoices",
    route: SupplierInvoiceRoute,
  },
  {
    path: "/subcontract-assignments",
    route: SubcontractingRoute,
  },
  {
    path: "/actions",
    route: ActionRoute,
  },
  {
    path: "/messages",
    route: MessageRoute,
  },
  {
    path: "/notifications",
    route: NotificationRoute,
  },
  {
    path: "/dashboard",
    route: DashboardRoute,
  },
  {
    path: "/portal",
    route: PortalRoute,
  },
  {
    path: "/customer-portal",
    route: PortalAdminRoute,
  },
  {
    path: "/sub-portal",
    route: SubPortalRoute,
  },
  {
    path: "/subcontractor-portal",
    route: SubPortalAdminRoute,
  },
  {
    path: "/website-webhook",
    route: WebsiteHookRoute,
  },
  {
    path: "/contracts",
    route: ContractRoute,
  },
  {
    path: "/chat",
    route: ChatRoutes,
  },
  {
    path: "/snelstart",
    route: SnelStartRoutes,
  },
];

moduleRoutes.forEach((route) => router.use(route.path, route.route));

export default router;

// now implement real time char using socket io. Write all code in this folder "src/app/modules/chat".
// Chat should be project wise
