// The kinds of notification. This is the enum "NotificationType" in the database (config/database.ts creates it
// from this list, plus OTHER, which only exists for an old row whose type is not known any more). A new kind is
// added HERE: `notify()` takes a TNotificationType, so it compiles everywhere, and initDatabase() adds the value
// to an existing database with ALTER TYPE ... ADD VALUE. It is a file of its own because the database set-up
// needs the list and must not import the notification service (which uses the database).

export const notificationTypes = [
  "MESSAGE",
  "MENTION",
  "ACTION_ASSIGNED",
  "NEW_INQUIRY",
  "QUOTE_ACCEPTED",
  "QUOTE_REJECTED",
  "ASSIGNMENT_RESPONSE",
  "PORTAL_MESSAGE",
  "ASSIGNMENT_UPDATE",
  "SUBSCRIPTION_UPDATE",
  "CHAT_MESSAGE",
  "SNELSTART_SYNC",
  "APPOINTMENT_COMPLETED",
  "APPOINTMENT_ASSIGNED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "WORK_ORDER_ASSIGNED",
  "WORK_ORDER_CHANGED",
] as const;
export type TNotificationType = (typeof notificationTypes)[number];
