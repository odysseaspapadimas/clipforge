import { createFileRoute } from "@tanstack/react-router";
import { createAuth } from "../server/auth.ts";
import { env } from "../server/env.ts";
import { stagingSignupGate } from "../server/staging-signup.ts";

const handler = async ({ request }: { request: Request }) =>
  await stagingSignupGate(request, String(env.STAGING_MODE) === "true", (env as typeof env & { STAGING_TEST_EMAIL?: string }).STAGING_TEST_EMAIL)
  ?? createAuth().handler(request);
export const Route = createFileRoute("/api/auth/$")({ server: { handlers: { GET: handler, POST: handler } } });
