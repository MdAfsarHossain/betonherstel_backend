// Project chat (real time): customers, office, admin, field crew and subcontractors talk about
// one project, in separate channels so nobody reads what is not meant for them.

// CUSTOMER / INTERNAL / SUBCONTRACTOR belong to a project; DIRECT (two employees) and GROUP (named, several
// employees) are staff conversations without a project that only their members can see
export const channelKinds = ["CUSTOMER", "INTERNAL", "SUBCONTRACTOR", "DIRECT", "GROUP"] as const;
export type TChannelKind = (typeof channelKinds)[number];
export const conversationKinds = ["DIRECT", "GROUP"] as const;
export const isConversationKind = (kind: string) => (conversationKinds as readonly string[]).includes(kind);
// Everyone who works for the company (and so may use staff chats)
export const employeeRoles = ["SUPERADMIN", "ADMIN", "OFFICE", "FIELD"] as const;
export const MAX_GROUP_MEMBERS = 50;

export const staffRoles = ["SUPERADMIN", "ADMIN", "OFFICE"] as const;
export const adminRoles = ["SUPERADMIN", "ADMIN"] as const;
export const chatRoles = ["SUPERADMIN", "ADMIN", "OFFICE", "FIELD", "CUSTOMER", "SUBCONTRACTOR"] as const;

// People outside the company see first names and a role label only
export const externalRoles = ["CUSTOMER", "SUBCONTRACTOR"] as const;

export const roleLabels: Record<string, string> = {
  SUPERADMIN: "Admin",
  ADMIN: "Admin",
  OFFICE: "Office",
  FIELD: "Field crew",
  CUSTOMER: "Customer",
  SUBCONTRACTOR: "Subcontractor",
};

export const channelLabels: Record<TChannelKind, string> = {
  CUSTOMER: "Customer",
  INTERNAL: "Internal",
  SUBCONTRACTOR: "Subcontractor",
  DIRECT: "Direct",
  GROUP: "Group",
};

// A closed project's chat stays open this many days, then it is read-only
export const READ_ONLY_AFTER_DAYS = 30;
export const MAX_BODY_LENGTH = 5000;
export const MAX_FILES_PER_MESSAGE = 5;
// The author can still correct a message for this long
export const EDIT_WINDOW_MINUTES = 15;
// Customers and subcontractors are emailed about a channel at most this often
export const EMAIL_EVERY_MINUTES = 10;

export interface IChatUser {
  id: string;
  name: string;
  role: string;
  relation_id: string | null;
}

// The project fields are null for a staff conversation (DIRECT / GROUP)
export interface IChatChannel {
  id: string;
  project_id: string | null;
  kind: TChannelKind;
  relation_id: string | null;
  project_number: string | null;
  project_title: string | null;
  customer_relation_id: string | null;
  project_manager_id: string | null;
  read_only: boolean;
  title: string | null;
  created_by: string | null;
}
