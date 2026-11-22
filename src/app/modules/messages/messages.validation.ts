import z from "zod";
import { recordTypes } from "../../utils/records";
import { notificationTypes } from "./notification.shared";

const uuid = (label: string) =>
  z.string().uuid({ message: `Invalid ${label}!` });

const entitySchema = z.object(
  {
    type: z.enum(recordTypes, { error: "Unknown kind of record!" }),
    id: uuid("record id"),
  },
  { error: "The record needs a type and an id!" },
);

const body = (label = "The message") =>
  z
    .string({ error: `${label} cannot be empty!` })
    .trim()
    .min(1, `${label} cannot be empty!`)
    .max(10000, `${label} is too long!`);

const mentions = z.array(uuid("user id")).max(20, "At most 20 mentions!");

const sendDirect = z.object({
  body: z.object({
    recipient_id: uuid("recipient id"),
    subject: z.string().trim().max(255).nullish(),
    body: body(),
  }),
});

const createComment = z.object({
  body: z.object({
    entity: entitySchema,
    body: body("The comment"),
    mentions: mentions.optional(),
  }),
});

const updateComment = z.object({
  body: z
    .object({
      body: body("The comment").optional(),
      mentions: mentions.optional(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "No fields to update",
    }),
});

const readEntity = z.object({ body: z.object({ entity: entitySchema }) });

const setPreferences = z.object({
  body: z.object({
    preferences: z
      .array(
        z
          .object({
            type: z.enum(notificationTypes, {
              error: `Type should be one of ${notificationTypes.join(", ")}!`,
            }),
            in_app: z.boolean().optional(),
            email: z.boolean().optional(),
          })
          .refine((p) => p.in_app !== undefined || p.email !== undefined, {
            message: "Give in_app and / or email!",
          }),
      )
      .min(1, "Give at least one preference!")
      .max(50),
  }),
});

export const MessageValidation = { sendDirect, createComment, updateComment };
export const NotificationValidation = { readEntity, setPreferences };
