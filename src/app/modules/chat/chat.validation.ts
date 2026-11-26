import z from "zod";
import { MAX_BODY_LENGTH, MAX_GROUP_MEMBERS } from "./chat.interface";

const uuid = (label: string) =>
  z.string().uuid({ message: `Invalid ${label}!` });

// Sent as JSON, or as multipart form fields next to the files
const sendMessage = z.object({
  body: z.object({
    message: z
      .string()
      .max(
        MAX_BODY_LENGTH,
        `A message can be at most ${MAX_BODY_LENGTH} characters!`,
      )
      .optional(),
    // The app's own id for this message: sending it again (a retry) never makes a second message
    client_id: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]{8,64}$/,
        "client_id must be 8-64 letters, digits, - or _!",
      )
      .optional(),
  }),
});

const editMessage = z.object({
  body: z.object({
    body: z
      .string({ error: "A message cannot be empty!" })
      .trim()
      .min(1, "A message cannot be empty!")
      .max(
        MAX_BODY_LENGTH,
        `A message can be at most ${MAX_BODY_LENGTH} characters!`,
      ),
  }),
});

const addMember = z.object({
  body: z.object({ user_id: uuid("user id") }),
});

const groupTitle = z
  .string({ error: "A group needs a name!" })
  .trim()
  .min(1, "A group needs a name!")
  .max(120, "A group name can be at most 120 characters!");

// Staff chats: ONE endpoint starts either a one-to-one chat ("single") or a named group ("group")
const createConversation = z.object({
  body: z.discriminatedUnion(
    "type",
    [
      z.object({
        type: z.literal("single"),
        user_id: uuid("user id"),
      }),
      z.object({
        type: z.literal("group"),
        title: groupTitle,
        member_ids: z
          .array(uuid("user id"), { error: "Choose the people for the group!" })
          .min(1, "Choose at least one other person!")
          .max(
            MAX_GROUP_MEMBERS - 1,
            `A group can have at most ${MAX_GROUP_MEMBERS} people!`,
          ),
      }),
    ],
    { error: 'type should be "single" or "group"!' },
  ),
});

const renameGroup = z.object({
  body: z.object({ title: groupTitle }),
});

export const ChatValidation = {
  sendMessage,
  editMessage,
  addMember,
  createConversation,
  renameGroup,
};
