import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const fixture = resolve(".local-dev/interview-fixture.mp4");
const log = resolve(".local-dev/vite-e2e.log");
const origin = "http://127.0.0.1:5173";

async function verificationLink(email: string): Promise<string> {
  for (let tries = 0; tries < 45; tries++) {
    const content = (existsSync(log) ? readFileSync(log, "utf8") : "").replaceAll(/\x1b\[[0-9;]*m/g, "");
    const position = content.lastIndexOf(`recipient: '${email}'`);
    const match = position >= 0 ? content.slice(position).match(/url: '(http[^']+verify-email[^']+)'/) : null;
    if (match) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Local verification email was not recorded");
}

test.beforeAll(() => {
  mkdirSync(resolve(".local-dev"), { recursive: true });
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", fixture], { timeout: 30_000 });
});

test("verified customer can upload, edit, export and download; other accounts cannot access it", async ({ page, browser }) => {
  const email = `creator-${Date.now()}@example.test`;
  const password = "Local-test-long-password-2026!";
  await page.goto("/sign-in");
  await page.locator("html[data-hydrated='true']").waitFor();
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Your name").fill("Podcast Creator");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("verification link");
  const url = await verificationLink(email);
  await page.goto(url);
  await page.goto("/studio");
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Podcast/ })).toBeVisible();
  await expect(page.getByText(/LOCAL SANDBOX/)).toBeVisible();
  await page.getByRole("button", { name: "Choose the Creator plan" }).click();
  await expect(page.locator(".minute-number")).toContainText("120");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.waitForURL(/\/studio\/[0-9a-f-]{36}/);
  await expect(page.getByText("ready", { exact: true })).toBeVisible({ timeout: 30_000 });
  const projectId = page.url().split("/").pop()!;
  await page.screenshot({ path: resolve(".local-dev/editor.png"), fullPage: true });
  const title = page.getByLabel("Clip title");
  await title.fill("A conversation worth sharing");
  await page.getByRole("button", { name: "Save edits" }).click();
  await expect(page.getByText("Edits saved.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await page.getByLabel(/Horizontal focus/).fill("600");
  await page.getByRole("button", { name: "Save edits" }).click();
  await page.getByRole("button", { name: "Export short" }).click();
  await expect(page.getByRole("link", { name: "Download MP4" })).toBeVisible({ timeout: 45_000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download MP4" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path!]).toString().trim());
  expect(duration).toBeGreaterThan(8);

  const clipId = new URL(download.url()).pathname.split("/").at(-2)!;
  const stranger = await browser.newContext({ baseURL: origin });
  const unauthorized = await stranger.request.get(`/api/projects/${projectId}`);
  expect(unauthorized.status()).toBe(401);
  const email2 = `stranger-${Date.now()}@example.test`;
  const other = await stranger.newPage();
  await other.goto("/sign-in");
  await other.locator("html[data-hydrated='true']").waitFor();
  await other.getByRole("button", { name: "Create an account" }).click();
  await other.getByLabel("Your name").fill("Other Creator");
  await other.getByLabel("Email address").fill(email2);
  await other.getByLabel("Password").fill(password);
  await other.getByRole("button", { name: "Create account" }).click();
  await expect(other.getByRole("status")).toContainText("verification link");
  await other.goto(await verificationLink(email2));
  expect((await stranger.request.get(`/api/projects/${projectId}`)).status()).toBe(404);
  expect((await stranger.request.get(`/api/projects/${projectId}/media`)).status()).toBe(404);
  expect((await stranger.request.get(`/api/clips/${clipId}/download`)).status()).toBe(404);
  await stranger.close();
});
