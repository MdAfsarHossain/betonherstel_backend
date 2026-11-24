import z from "zod";
import { MAX_BODY_LENGTH } from "./chat.interface";

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

export const ChatValidation = { sendMessage, editMessage, addMember };
