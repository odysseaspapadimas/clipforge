import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import { accounts, rateLimits, sessions, users, verifications } from "./schema.ts";
import { env } from "./env.ts";

async function sendEmail(recipient: string, subject: string, url: string) {
  if (String(env.DEV_MODE) === "true") {
    console.info("LOCAL AUTH LINK (offline only)", { recipient, subject, url });
    return;
  }
  if (!env.EMAIL_FROM) throw new Error("Auth sender is not configured");
  const nativeEmail = (env as typeof env & { EMAIL?: SendEmail }).EMAIL;
  if (nativeEmail) {
    const address = env.EMAIL_FROM.match(/<([^<>]+)>/)?.[1] ?? env.EMAIL_FROM;
    await nativeEmail.send({ from: { email: address, name: "Clipforge" }, to: recipient,
      subject, text: `${subject}: ${url}` });
    return;
  }
  const apiKey = (env as typeof env & { EMAIL_API_KEY?: string }).EMAIL_API_KEY;
  if (!apiKey) throw new Error("Auth email service is not configured");
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: {
    Authorization: `Bearer ${apiKey}`, "content-type": "application/json",
  }, body: JSON.stringify({ from: env.EMAIL_FROM, to: [recipient], subject, text: `${subject}: ${url}` }) });
  if (!response.ok) throw new Error(`Auth email send failed (${response.status})`);
}
export function createAuth() {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters");
  return betterAuth({
    secret: env.AUTH_SECRET, baseURL: env.APP_ORIGIN, basePath: "/api/auth",
    trustedOrigins: [env.APP_ORIGIN],
    database: drizzleAdapter(drizzle(env.DB), { provider: "sqlite", schema: {
      user: users, session: sessions, account: accounts, verification: verifications, rateLimit: rateLimits,
    } }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true, sendResetPassword: async ({ user, url }) => {
        await sendEmail(user.email, "Reset your Clipforge password", url);
      },
    },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(user.email, "Verify your Clipforge email", url);
      },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 20,
      customRules: { "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 } },
    },
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    plugins: [tanstackStartCookies()],
  });
}
export async function requireUser(headers: Headers) {
  const session = await createAuth().api.getSession({ headers });
  if (!session?.user.id || !session.user.emailVerified) return null;
  return { id: session.user.id, email: session.user.email, name: session.user.name };
}
