#!/usr/bin/env bun
/** Local, offline verification. Never reads .env, cloud credentials, or staging state. */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const commands: { name: string; argv: string[]; evidence: string }[] = [
  { name: "migrations", argv: ["bun", "run", "db:check"], evidence: "offline schema consistency" },
  { name: "types", argv: ["bun", "run", "typecheck"], evidence: "static type check" },
  { name: "unit-and-renderer", argv: ["bun", "test", "test", "renderer"], evidence: "offline unit tests (FFmpeg installed)" },
  { name: "build", argv: ["bun", "run", "build"], evidence: "local production build" },
  { name: "browser", argv: ["bun", "run", "test:e2e"], evidence: "offline fake-provider browser journey; NOT live billing/transcription/email" },
];

async function capture(argv: string[]): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

const usage = "Usage: bun scripts/verify.ts local [--allow-dirty]";
const args = process.argv.slice(2);
if (args[0] !== "local" || args.some((arg, i) => i > 0 && arg !== "--allow-dirty")) {
  console.error(usage);
  process.exit(2);
}
const shaResult = await capture(["git", "rev-parse", "HEAD"]);
const statusResult = await capture(["git", "status", "--porcelain", "--untracked-files=normal"]);
if (shaResult.exitCode || statusResult.exitCode) throw new Error("Cannot identify Git HEAD and worktree state");
const sha = shaResult.output.trim();
const dirty = statusResult.output.trim().length > 0;
if (dirty && !args.includes("--allow-dirty")) {
  console.error("Refusing to label dirty code by HEAD. Commit first, or use --allow-dirty (unverified SHA).");
  process.exit(2);
}
const stamp = new Date().toISOString().replaceAll(":", "-");
const dir = join(root, ".local-dev", "verification", `${sha.slice(0, 12)}${dirty ? "-dirty" : ""}-${stamp}`);
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const checks: { name: string; status: string; exitCode: number; durationMs: number; evidence: string; log: string }[] = [];
for (const item of commands) {
  const start = Date.now();
  const result = await capture(item.argv);
  const log = `${item.name}.log`;
  await writeFile(join(dir, log), result.output, { mode: 0o600 });
  checks.push({ name: item.name, status: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, durationMs: Date.now() - start, evidence: item.evidence, log });
  console.log(`${item.name}: ${checks.at(-1)!.status} (${checks.at(-1)!.durationMs}ms)`);
}
const report = {
  schemaVersion: 1, gitSha: sha, dirty, shaPinned: !dirty, createdAt: new Date().toISOString(),
  scope: "local-offline", liveProviderJourney: "not-tested", cloudDeployment: "not-tested",
  checks, outcome: checks.every(c => c.status === "passed") ? "passed" : "failed",
  limitations: ["Fake providers in browser E2E", "No staging email, live billing, ASR, or Container journey verified by this command"],
};
await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`Private evidence: ${join(dir, "report.json")}`);
if (report.outcome !== "passed") process.exitCode = 1;
