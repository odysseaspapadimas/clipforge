import { expect, test } from "bun:test";
import { stagingSignupGate } from "../src/server/staging-signup.ts";
const url = "https://clipforge-staging-web.example.workers.dev/api/auth/sign-up/email";
const signup = (email: string) => new Request(url, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Staging creator", email, password: "a-long-unique-password" }) });
test("only the exact configured staging account may sign up; production is unaffected", async () => {
  expect(await stagingSignupGate(signup("anywhere@example.com"), false)).toBeNull();
  expect(await stagingSignupGate(signup("invite@owner.test"), true, "invite@owner.test")).toBeNull();
  expect((await stagingSignupGate(signup("elsewhere@example.com"), true, "invite@owner.test"))?.status).toBe(403);
  expect((await stagingSignupGate(signup("invite@owner.test"), true))?.status).toBe(503);
  expect((await stagingSignupGate(new Request(url, { method: "POST", headers: { "content-type": "application/json" },
    body: "not json" }), true, "invite@owner.test"))?.status).toBe(403);
  expect(await stagingSignupGate(new Request(url.replace("sign-up", "sign-in"), { method: "POST" }), true, "invite@owner.test")).toBeNull();
});
