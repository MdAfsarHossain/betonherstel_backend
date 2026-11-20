import z from "zod";

// bcrypt only uses the first 72 bytes of a password, so longer ones are rejected
const passwordSchema = (label: string) =>
  z
    .string({ error: `${label} is required!` })
    .min(8, "Password should be at least 8 characters")
    .max(72, "Password should be at most 72 characters");

const loginUser = z.object({
  body: z.object({
    email: z
      .string({
        error: "Email is required!",
      })
      .email({
        message: "Invalid email format!",
      }),
    password: z.string({
      error: "Password is required!",
    }),
    fcm_token: z.string().optional(),
  }),
});

const refreshToken = z.object({
  body: z.object({
    refreshToken: z.string({ error: "refreshToken is required!" }),
  }),
});

const forgotPassword = z.object({
  body: z.object({
    email: z
      .string({
        error: "Email is required!",
      })
      .email({
        message: "Invalid email format!",
      }),
  }),
});

const resetPassword = z.object({
  body: z.object({
    token: z
      .string({ error: "token is required!" })
      .regex(/^[0-9a-f]{64}$/, "This reset link is invalid or has expired!"),
    newPassword: passwordSchema("Password"),
  }),
});

const changePassword = z.object({
  body: z.object({
    oldPassword: z.string({
      error: "old Password is required!",
    }),
    newPassword: passwordSchema("New password"),
  }),
});

const codeSchema = z
  .string({ error: "code is required!" })
  .regex(/^[0-9]{6}$/, "The code must be 6 digits!");

const twoFactorVerifyLogin = z.object({
  body: z
    .object({
      twoFactorToken: z.string({ error: "twoFactorToken is required!" }),
      code: codeSchema.optional(),
      recoveryCode: z.string().min(8).max(20).optional(),
    })
    .refine((b) => b.code || b.recoveryCode, {
      message: "Enter the 6-digit code or a recovery code!",
      path: ["code"],
    }),
});

const twoFactorEnable = z.object({
  body: z.object({ code: codeSchema }),
});

const twoFactorDisable = z.object({
  body: z.object({
    password: z.string({ error: "Password is required!" }),
    code: codeSchema,
  }),
});

export const authValidation = {
  loginUser,
  refreshToken,
  forgotPassword,
  resetPassword,
  changePassword,
  twoFactorVerifyLogin,
  twoFactorEnable,
  twoFactorDisable,
};
