import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins/email-otp";
import { getDb, schema } from "../db/client";
import { sendEmployeeEmail } from "../email/send-employee";
import type { AppEnv } from "../env";

export function createAuth(env: AppEnv) {
  return betterAuth({
    appName: "Minocy IT Help",
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(getDb(env.DB), {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    user: {
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "employee", input: false },
        department: { type: "string", required: false, input: false },
        location: { type: "string", required: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        // Only seeded/provisioned users can sign in — no self sign-up.
        disableSignUp: true,
        async sendVerificationOTP({ email, otp }) {
          await sendEmployeeEmail(env, {
            to: email,
            subject: `Your Minocy IT Help sign-in code: ${otp}`,
            text: `Your sign-in code is ${otp}. It expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`,
            html: `<p>Your sign-in code is <strong style="font-size:20px;letter-spacing:2px">${otp}</strong>.</p><p>It expires in 10 minutes. If you didn't request this, ignore this email.</p>`,
          });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type SessionUser = Auth["$Infer"]["Session"]["user"];
