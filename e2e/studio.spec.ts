import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { cropFilter } from "../renderer/captions.ts";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const fixture = resolve(".local-dev/interview-fixture.mp4");
const rotatedFixture = resolve(".local-dev/interview-rotated.mp4");
const log = resolve(".local-dev/vite-e2e.log");
const origin = `http://127.0.0.1:${process.env.CLIPFORGE_DEV_PORT ?? 5173}`;

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
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-display_rotation:v:0", "90", "-i", fixture,
    "-c", "copy", rotatedFixture], { timeout: 30_000 });
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
  await page.route("**/api/me", async (route) => { await new Promise((resolve) => setTimeout(resolve, 1500)); await route.continue(); });
  await page.reload();
  await expect(page.getByRole("button", { name: "Checking your plan…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Manage subscription" })).toBeEnabled();
  await page.unroute("**/api/me");
  await page.locator('input[type="file"]').setInputFiles({ name: "unpreviewable.mov", mimeType: "video/quicktime", buffer: Buffer.from("not a browser video") });
  await expect(page.getByRole("alert")).toContainText("Convert to H.264/AAC MP4");
  await expect(page.locator(".library-count")).toContainText("0 PROJECTS");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.waitForURL(/\/studio\/[0-9a-f-]{36}/);
  await expect(page.getByText("ready", { exact: true })).toBeVisible({ timeout: 30_000 });
  const projectId = page.url().split("/").pop()!;
  await page.screenshot({ path: resolve(".local-dev/editor.png"), fullPage: true });
  const title = page.getByLabel("Clip title");
  await title.fill("A conversation worth sharing");
  await page.getByRole("button", { name: "Save edits" }).click();
  await expect(page.getByText("Edits saved.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Captions", exact: true }).click();
  const captionText = page.getByLabel("Caption 1 text");
  await expect(captionText).toBeVisible();
  await captionText.fill("Corrected");
  const firstStart = page.getByLabel("Caption 1 start");
  await firstStart.fill("0.1");
  await page.getByLabel("New caption word").fill("Inserted");
  await page.getByRole("button", { name: "Add word after caption 1", exact: true }).click();
  await expect(page.getByLabel("Caption 2 text")).toHaveValue("Inserted");
  const removedText = await page.getByLabel("Caption 3 text").inputValue();
  const removedStart = Number(await page.getByLabel("Caption 3 start").inputValue()) * 1000;
  await page.getByRole("button", { name: "Remove caption 3", exact: true }).click();
  await page.getByRole("button", { name: "Save edits" }).click();
  await expect(captionText).toHaveValue("Corrected");
  await expect(firstStart).toHaveValue("0.1");
  const savedCaptions = await (await page.request.get(`/api/projects/${projectId}`)).json();
  expect(savedCaptions.clips[0].captions[1].text).toBe("Inserted");
  expect(savedCaptions.clips[0].captions.some((item: { text: string; startMs: number }) =>
    item.text === removedText && item.startMs === removedStart)).toBe(false);
  await page.getByRole("button", { name: "Cut", exact: true }).click();
  await page.getByLabel("End (seconds)").fill("9");
  await page.getByRole("button", { name: "Save edits" }).click();
  await expect(page.locator(".edit-version")).toHaveText("V4");
  await page.getByLabel("End (seconds)").fill("12");
  await page.getByRole("button", { name: "Save edits" }).click();
  const expanded = await page.request.get(`/api/projects/${projectId}`);
  const expandedData = await expanded.json();
  expect(expandedData.clips[0].captions.some((word: { startMs: number }) => word.startMs > 9_000)).toBe(true);
  expect(expandedData.clips[0].captions[0].text).toBe("Corrected");
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await page.getByLabel(/Zoom/).fill("2000");
  for (const focus of [0, 1000]) {
    await page.getByLabel(/Horizontal focus/).fill(String(focus));
    const video = page.locator(".preview-viewport video");
    await video.evaluate(async (node) => {
      const element = node as HTMLVideoElement;
      if (element.readyState < 2) await new Promise<void>((resolve) => element.addEventListener("loadeddata", () => resolve(), { once: true }));
      element.currentTime = .5;
      await new Promise<void>((resolve) => element.addEventListener("seeked", () => resolve(), { once: true }));
    });
    const viewport = page.locator(".preview-viewport");
    const screenshot = await viewport.screenshot();
    const [width, height] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height",
      "-of", "csv=p=0:s=x", "-i", "pipe:0"], { input: screenshot }).toString().trim().split("x").map(Number);
    const browser = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
      { input: screenshot, maxBuffer: 10_000_000 });
    const rendered = execFileSync("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", fixture,
      "-frames:v", "1", "-vf", `${cropFilter(640, 360, focus, 500, 2000)},scale=${width}:${height}:flags=lanczos`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 10_000_000 });
    expect(browser.length).toBe(width * height * 3);
    expect(rendered.length).toBe(browser.length);
    let errorSum = 0, samples = 0;
    // Avoid the preview play control and captions; compare the actual top-third frame pixels.
    for (let y = 8; y < height / 3; y += 3) for (let x = 8; x < width - 8; x += 3) {
      const index = (y * width + x) * 3;
      for (let color = 0; color < 3; color++) { errorSum += Math.abs(browser[index + color] - rendered[index + color]); samples++; }
    }
    expect(errorSum / samples).toBeLessThan(25);
  }
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
  // Simulate the R2 lifecycle cutoff without waiting 90 days; stale links must be gated before cleanup.
  const localDb = new DatabaseSync(resolve(".local-dev/clipforge.sqlite"));
  localDb.prepare("UPDATE project SET created_at = ? WHERE id = ?")
    .run(Date.now() - 90 * 86_400_000 - 60_000, projectId);
  localDb.close();
  expect((await page.request.get(`/api/projects/${projectId}/media`)).status()).toBe(410);
  expect((await page.request.get(`/api/clips/${clipId}/download`)).status()).toBe(410);
  page.once("dialog", (dialog) => dialog.accept());
  await page.goto("/studio");
  await expect(page.getByText("Media expired")).toBeVisible();
  await page.getByRole("button", { name: "Delete interview-fixture" }).click();
  await expect(page.getByRole("button", { name: "Delete interview-fixture" })).toHaveCount(0);
  expect((await page.request.get(`/api/projects/${projectId}`)).status()).toBe(404);
  expect((await page.request.get(`/api/clips/${clipId}/download`)).status()).toBe(404);
  const stored = readdirSync(resolve(".local-dev/media"), { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile()).map((item) => `${item.parentPath}/${item.name}`);
  expect(stored.some((key) => key.includes(projectId) || key.includes(clipId))).toBe(false);
  const me = await (await page.request.get("/api/me")).json() as { user: { id: string } };
  const staleId = crypto.randomUUID(), queuedId = crypto.randomUUID();
  const db = new DatabaseSync(resolve(".local-dev/clipforge.sqlite"));
  db.prepare(`INSERT INTO project(id,user_id,title,source_key,file_size,mime_type,status,created_at,updated_at)
    VALUES (?,?,?,?,1,'video/mp4','ready',?,?)`).run(staleId, me.user.id, "expired source",
      `users/${me.user.id}/sources/${staleId}/original`, Date.now() - 92 * 86_400_000, Date.now());
  db.prepare(`INSERT INTO project(id,user_id,title,source_key,file_size,mime_type,status,queued_at,created_at,updated_at)
    VALUES (?,?,?,?,1,'video/mp4','queued',?,?,?)`).run(queuedId, me.user.id, "orphan queued",
      `users/${me.user.id}/sources/${queuedId}/original`, Date.now(), Date.now(), Date.now());
  db.close();
  await page.goto("/studio");
  await expect(page.getByRole("button", { name: "Delete orphan queued" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete orphan queued" }).click();
  await expect(page.getByRole("button", { name: "Delete orphan queued" })).toHaveCount(0);
  expect((await page.request.get(`/api/projects/${queuedId}`)).status()).toBe(404);
  const library = await (await page.request.get("/api/projects")).json() as { projects: Array<{ id: string }> };
  expect(library.projects.some((item) => item.id === staleId)).toBe(false);
});

test("renderer probes display dimensions after FFmpeg autorotation", async () => {
  const renderer = `http://127.0.0.1:${process.env.CLIPFORGE_RENDERER_PORT ?? 8080}`;
  const input = new Blob([new Uint8Array(readFileSync(rotatedFixture))]);
  const probe = await fetch(`${renderer}/probe`, { method: "POST", body: input });
  expect(probe.status).toBe(200);
  const metadata = await probe.json() as { width: number; height: number };
  expect(metadata).toMatchObject({ width: 360, height: 640 });
  const render = await fetch(`${renderer}/render`, { method: "POST", body: input,
    headers: { "x-clipforge-render": JSON.stringify({ startMs: 0, endMs: 8_500, cropX: 500, cropY: 500, zoom: 1000, captions: [] }) } });
  expect(render.status).toBe(200);
  const output = resolve(".local-dev/rotation-export.mp4");
  writeFileSync(output, Buffer.from(await render.arrayBuffer()));
  try {
    const dimensions = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-select_streams", "v:0",
      "-of", "csv=p=0:s=x", output]).toString().trim();
    expect(dimensions).toBe("1080x1920");
  } finally { unlinkSync(output); }
});
