// Pure deployment preflight. Do not let Alchemy apply a public Worker with a
// bogus callback origin, an undeliverable sender or a live Stripe key.
export const stagingWorkerName = "clipforge-staging-web";

export type StagingConfiguration = {
  stage: string;
  stripeKey?: string;
  appOrigin?: string;
  emailFrom?: string;
  emailProvider?: string;
  emailApiKey?: string;
  authSecret?: string;
  internalSecret?: string;
};

export function assertExpectedCloudflareAccount(expected: string | undefined, resolved: string): void {
  if (!expected || !/^[0-9a-f]{32}$/i.test(expected) || resolved !== expected) {
    throw new Error("Cloudflare profile account does not match the expected Clipforge staging account.");
  }
}

export function assertStagingConfiguration(config: StagingConfiguration): void {
  if (config.stage !== "staging") throw new Error("Only the guarded staging stage is authorized.");
  if (!config.stripeKey?.startsWith("sk_test_")) throw new Error("Stripe TEST-mode credentials are required.");
  const origin = config.appOrigin ? URL.parse(config.appOrigin) : null;
  if (!origin || origin.protocol !== "https:" || origin.origin !== config.appOrigin ||
    origin.username || origin.password ||
    !new RegExp(`^${stagingWorkerName}\\.[a-z0-9-]+\\.workers\\.dev$`).test(origin.hostname)) {
    throw new Error("APP_ORIGIN must be the dedicated Clipforge staging workers.dev hostname.");
  }
  const sender = config.emailFrom?.match(/<([^<>]+)>/)?.[1] ?? config.emailFrom;
  const senderDomain = sender?.split("@")[1] ?? "";
  if (!sender || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(sender) ||
    /\.(invalid|test|example|localhost|workers\.dev)$/i.test(senderDomain)) {
    throw new Error("Use a verified domain you control for outbound email; workers.dev is not a sender domain.");
  }
  if (config.emailProvider !== "cloudflare" && !config.emailApiKey) {
    throw new Error("Configure Cloudflare Email Sending or a verified Resend sender before staging.");
  }
  if (!config.authSecret || config.authSecret.length < 32 ||
    !config.internalSecret || config.internalSecret.length < 32 ||
    config.authSecret === config.internalSecret) {
    throw new Error("Staging requires two distinct 32+ character secrets.");
  }
}
