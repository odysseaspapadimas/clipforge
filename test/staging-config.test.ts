import { expect, test } from "bun:test";
import { assertStagingConfiguration, stagingWorkerName, type StagingConfiguration } from "../src/infra/staging-config.ts";

const valid: StagingConfiguration = {
  stage: "staging", stripeKey: "sk_test_fixture_only",
  appOrigin: `https://${stagingWorkerName}.account-subdomain.workers.dev`,
  emailFrom: "Clipforge <auth@clipforge.example.org>", emailProvider: "cloudflare",
  authSecret: "a".repeat(48), internalSecret: "b".repeat(48),
};
const check = (override: Partial<StagingConfiguration>) =>
  assertStagingConfiguration({ ...valid, ...override });

test("only allows dedicated HTTPS workers.dev staging and TEST Stripe", () => {
  expect(() => check({})).not.toThrow();
  for (const stage of ["production", "dev", ""]) expect(() => check({ stage })).toThrow();
  for (const stripeKey of ["sk_live_not_a_real_key", "", undefined]) {
    expect(() => check({ stripeKey })).toThrow();
  }
  for (const appOrigin of ["https://staging.clipforge.invalid", "https://another-app.account.workers.dev",
    "http://clipforge-staging-web.account.workers.dev", "https://clipforge-staging-web.account.workers.dev/path",
    "https://clipforge-staging-web.account.workers.dev@evil.test", undefined]) {
    expect(() => check({ appOrigin })).toThrow();
  }
});

test("workers.dev hosts cannot send email; staging requires real sender and separate secrets", () => {
  for (const emailFrom of ["auth@account.workers.dev", "auth@staging.example.invalid", "auth@example.test", "wrong", undefined]) {
    expect(() => check({ emailFrom })).toThrow();
  }
  expect(() => check({ emailProvider: "resend", emailApiKey: undefined })).toThrow();
  expect(() => check({ emailProvider: "resend", emailApiKey: "staging-key" })).not.toThrow();
  expect(() => check({ internalSecret: valid.authSecret })).toThrow();
  expect(() => check({ authSecret: "too-short" })).toThrow();
});
