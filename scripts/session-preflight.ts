#!/usr/bin/env bun
/** Read-only launch gate for Clipforge Pi sessions. Never prints env values or calls a cloud API. */
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export type Intent = "pr" | "investigation" | "persistent";
export function worktrees(text: string): { path: string; branch: string }[] {
  return text.split(/\n\n/).flatMap(block => {
    const lines = block.split("\n");
    const path = lines.find(line => line.startsWith("worktree "))?.slice(9);
    if (!path || lines.some(line => line.startsWith("prunable"))) return [];
    return [{ path, branch: lines.find(line => line.startsWith("branch refs/heads/"))?.slice(18) ?? "detached" }];
  });
}
export function localEnvIsSafe(env: NodeJS.ProcessEnv): boolean {
  const ports = [env.CLIPFORGE_DEV_PORT, env.CLIPFORGE_RENDERER_PORT].map(Number);
  return ports.every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) && ports[0] !== ports[1] &&
    !["ALCHEMY_STAGE", "STRIPE_API_KEY", "CLIPFORGE_AUTH_SECRET", "CLIPFORGE_INTERNAL_SECRET", "CLIPFORGE_DEEPGRAM_KEY", "CLIPFORGE_EMAIL_API_KEY"].some(key => Boolean(env[key]));
}

const root = resolve(import.meta.dir, "..");
async function run(argv: string[], cwd = root): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, out: out.trim() };
}
async function checked(argv: string[], cwd = root) {
  const result = await run(argv, cwd);
  if (result.code !== 0) throw new Error(`Preflight failed: ${argv[0]} ${argv[1] ?? ""}`);
  return result.out;
}

export async function preflight(intent: Intent, requestedPath: string) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) throw new Error("Start the orchestrator inside the Clipforge Herdr workspace");
  const workspace = JSON.parse(await checked(["herdr", "workspace", "get", process.env.HERDR_WORKSPACE_ID]));
  if (workspace.result?.workspace?.label !== "Clipforge") throw new Error("Current Herdr workspace is not Clipforge");
  const path = await realpath(resolve(requestedPath));
  const listed = worktrees(await checked(["git", "worktree", "list", "--porcelain"]));
  const tree = listed.find(entry => entry.path === path);
  if (!tree) throw new Error("Path is not a live Clipforge worktree");
  if (await checked(["git", "rev-parse", "--show-toplevel"], path) !== path) throw new Error("Path must be the checkout root");
  const sha = await checked(["git", "rev-parse", "HEAD"], path);
  const dirty = Boolean(await checked(["git", "status", "--porcelain", "--untracked-files=normal"], path));
  if (intent === "investigation") return { intent, cwd: path, branch: tree.branch, sha, dirty, env: "not-required", workspaceId: process.env.HERDR_WORKSPACE_ID };
  if (tree.branch === "main" || tree.branch === "detached") throw new Error("Editing sessions require a named feature worktree, not main/detached HEAD");
  if (dirty) throw new Error("Start the editing session from a clean worktree; preserve or review existing changes first");
  // Only identical, reviewed project env code is eligible for unattended approval.
  const trusted = await checked(["git", "show", "refs/heads/main:.envrc"]);
  let actual: string;
  try { actual = (await readFile(join(path, ".envrc"), "utf8")).trim(); }
  catch { throw new Error("Checkout lacks .envrc; update it from the reviewed main before launching an editing session"); }
  if (actual !== trusted) throw new Error("Checkout .envrc differs from main; review it explicitly, never auto-allow a changed script");
  const probe = await run(["direnv", "exec", path, "bun", join(root, "scripts/session-env-probe.ts")], path);
  if (probe.code !== 0) throw new Error(`Checkout env unavailable or privileged variables are present. Review .envrc, approve with direnv allow ${path} only if trusted, and clear any staging credentials from the local launch environment`);
  let ports: { devPort: number; rendererPort: number };
  try { ports = JSON.parse(probe.out); }
  catch { throw new Error("Local env probe did not return valid port metadata"); }
  return { intent, cwd: path, branch: tree.branch, sha, dirty, env: "approved-local", ...ports, workspaceId: process.env.HERDR_WORKSPACE_ID };
}

if (import.meta.main) {
  const intent = process.argv[2];
  const path = process.argv[3];
  if (!["pr", "investigation", "persistent"].includes(intent) || !path || process.argv.length !== 4) {
    console.error("Usage: bun scripts/session-preflight.ts <pr|investigation|persistent> <checkout-path>");
    process.exit(2);
  }
  try { console.log(JSON.stringify(await preflight(intent as Intent, path), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Preflight failed"); process.exit(1); }
}
