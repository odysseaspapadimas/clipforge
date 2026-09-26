import { z } from "zod";
import { readJson } from "./json.ts";

/** Staging is publicly routable; never turn its TEST checkout or AI allowance into open signup. */
export async function stagingSignupGate(request: Request, staging: boolean, allowedEmail?: string): Promise<Response | null> {
  if (!staging || request.method !== "POST" || new URL(request.url).pathname !== "/api/auth/sign-up/email") return null;
  if (!allowedEmail || !z.email().safeParse(allowedEmail).success) {
    return Response.json({ code: "STAGING_CLOSED", message: "Staging signup is closed" }, { status: 503 });
  }
  try {
    const body = z.object({ email: z.email() }).passthrough().parse(await readJson(request.clone() as unknown as Parameters<typeof readJson>[0]));
    if (body.email.toLowerCase() === allowedEmail.toLowerCase()) return null;
  } catch { /* Never disclose whether an address is on the private allowlist. */ }
  return Response.json({ code: "STAGING_INVITE_ONLY", message: "Staging signup is invite-only" }, { status: 403 });
}
