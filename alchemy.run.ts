import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Billing from "./src/workers/billing.ts";
import { Database, Media } from "./src/infra/data.ts";
import type { RenderContainer } from "./src/workers/processor.ts";

// External Deepgram is an explicit, key-gated fallback until Nova-3 on Workers AI
// has been exercised against short and long real speech on the staging account.
const transcriptionBackend = process.env.CLIPFORGE_TRANSCRIPTION_BACKEND ?? "workers-ai";
if (transcriptionBackend !== "workers-ai" && transcriptionBackend !== "deepgram") {
  throw new Error("CLIPFORGE_TRANSCRIPTION_BACKEND must be workers-ai or deepgram");
}
const emailSender = process.env.CLIPFORGE_EMAIL_FROM?.match(/<([^<>]+)>/)?.[1] ?? process.env.CLIPFORGE_EMAIL_FROM;

export const Processor = Cloudflare.Worker("ClipforgeProcessor", {
  main: "./src/workers/processor.ts", workersDev: false,
  observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
  env: {
    DB: Database, MEDIA: Media,
    INGEST: Cloudflare.Workflow<{ projectId: string }>("ClipforgeIngest", { className: "IngestWorkflow" }),
    EXPORT: Cloudflare.Workflow<{ jobId: string }>("ClipforgeExport", { className: "ExportWorkflow" }),
    RENDER: Cloudflare.Container<RenderContainer>("ClipforgeRenderer", {
      className: "RenderContainer", context: "./renderer", dockerfile: "./renderer/Dockerfile",
      instanceType: "standard-2", maxInstances: 2,
      observability: { logs: { enabled: true } },
    }),
    AI: Cloudflare.Workers.AI(),
    TRANSCRIPTION_BACKEND: transcriptionBackend,
    ...(transcriptionBackend === "deepgram" ? { DEEPGRAM_KEY: Config.Redacted("CLIPFORGE_DEEPGRAM_KEY") } : {}),
    INTERNAL_SECRET: Config.Redacted("CLIPFORGE_INTERNAL_SECRET"),
  },
});

export const Website = Cloudflare.Website.Vite("ClipforgeWebsite", {
  env: {
    DB: Database, MEDIA: Media,
    AUTH_SECRET: Config.Redacted("CLIPFORGE_AUTH_SECRET"),
    INTERNAL_SECRET: Config.Redacted("CLIPFORGE_INTERNAL_SECRET"),
    ...(process.env.CLIPFORGE_EMAIL_PROVIDER === "cloudflare"
      ? { EMAIL: Cloudflare.Email.SendEmail("ClipforgeAuthEmail", {
        allowedSenderAddresses: emailSender ? [emailSender] : [],
      }) }
      : { EMAIL_API_KEY: Config.Redacted("CLIPFORGE_EMAIL_API_KEY") }),
    EMAIL_FROM: Config.String("CLIPFORGE_EMAIL_FROM"),
    APP_ORIGIN: Config.String("CLIPFORGE_APP_ORIGIN"),
    DEV_MODE: "false", STAGING_MODE: "true",
    PROCESSOR: Processor, BILLING: Billing,
  },
  observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
});
export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;
export type ProcessorEnv = Cloudflare.InferEnv<typeof Processor>;

export default Alchemy.Stack("Clipforge", {
  providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
  state: Cloudflare.state(),
}, Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  if (stage !== "staging") throw new Error("Clipforge only permits the guarded staging stage; production is not authorized.");
  if (!process.env.STRIPE_API_KEY?.startsWith("sk_test_")) {
    throw new Error("A Stripe TEST-mode key is required even to plan the complete staging stack.");
  }
  const origin = process.env.CLIPFORGE_APP_ORIGIN;
  const parsedOrigin = origin ? URL.parse(origin) : null;
  if (!parsedOrigin || parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin ||
    parsedOrigin.username || parsedOrigin.password || /(^localhost$|\.invalid$)/i.test(parsedOrigin.hostname)) {
    throw new Error("Use the actual HTTPS Clipforge staging hostname, never a placeholder APP_ORIGIN.");
  }
  if (!emailSender || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(emailSender) ||
    /\.invalid$/i.test(emailSender.split("@")[1] ?? "")) {
    throw new Error("Use a verified staging email sender, never a placeholder EMAIL_FROM.");
  }
  if (process.env.CLIPFORGE_EMAIL_PROVIDER !== "cloudflare" && !process.env.CLIPFORGE_EMAIL_API_KEY) {
    throw new Error("Configure Cloudflare Email Sending or a verified Resend sender before staging.");
  }
  if (!process.env.CLIPFORGE_AUTH_SECRET || process.env.CLIPFORGE_AUTH_SECRET.length < 32 ||
    !process.env.CLIPFORGE_INTERNAL_SECRET || process.env.CLIPFORGE_INTERNAL_SECRET.length < 32 ||
    process.env.CLIPFORGE_AUTH_SECRET === process.env.CLIPFORGE_INTERNAL_SECRET) {
    throw new Error("Staging requires two distinct 32+ character secrets.");
  }
  const db = yield* Database;
  const media = yield* Media;
  const processor = yield* Processor;
  const billing = yield* Billing;
  const site = yield* Website;
  return { websiteUrl: site.url, processorName: processor.workerName,
    billingName: billing.workerName, databaseName: db.databaseName, bucketName: media.bucketName };
}));
