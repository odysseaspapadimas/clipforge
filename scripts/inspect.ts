#!/usr/bin/env bun
/** Read-only snapshot: Git worktrees, PR checks, local evidence and Herdr agents. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
async function run(argv: string[], cwd = root) {
  try {
    const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? text.trim() : "";
  } catch { return ""; }
}
const worktreeText = await run(["git", "worktree", "list", "--porcelain"]);
const trees = worktreeText.split(/\n\n/).filter(Boolean).map(section => {
  const values = Object.fromEntries(section.split("\n").map(line => [line.split(" ")[0], line.slice(line.indexOf(" ") + 1)]));
  return { path: values.worktree, sha: values.HEAD, branch: values.branch?.replace(/^refs\/heads\//, "") ?? "detached" };
}).filter(t => t.path && t.sha);
let prs: any[] = [];
try { prs = JSON.parse(await run(["gh", "pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,headRefName,headRefOid,isDraft,statusCheckRollup"])); } catch { /* gh optional */ }
let agents: any[] = [];
if (process.env.HERDR_ENV === "1") {
  try {
    const raw = JSON.parse(await run(["herdr", "agent", "list"]));
    agents = raw.result?.agents ?? [];
  } catch { /* Herdr optional */ }
}
async function findEvidence(path: string, sha: string) {
  const reportRoot = join(path, ".local-dev", "verification");
  try {
    const dirs = (await readdir(reportRoot)).sort().reverse().slice(0, 100);
    for (const dir of dirs) {
      try {
        const json = JSON.parse(await readFile(join(reportRoot, dir, "report.json"), "utf8"));
        if (json.schemaVersion === 1 && json.gitSha === sha && json.dirty === false)
          return { sha: json.gitSha, outcome: json.outcome, scope: json.scope, createdAt: json.createdAt };
      } catch { /* missing or invalid report */ }
    }
  } catch { /* no local evidence */ }
  return null;
}
const snapshot = [];
for (const tree of trees) {
  const dirty = !!(await run(["git", "status", "--porcelain", "--untracked-files=normal"], tree.path));
  const pr = prs.find(p => p.headRefName === tree.branch);
  const evidence = await findEvidence(tree.path, tree.sha);
  const checks = (pr?.statusCheckRollup ?? []).map((c: any) => ({ name: c.name ?? c.context ?? "check", status: c.conclusion || c.state || c.status || "pending" }));
  snapshot.push({ path: tree.path, branch: tree.branch, sha: tree.sha, dirty, pr: pr ? { number: pr.number, title: pr.title, url: pr.url, draft: pr.isDraft, headMatches: pr.headRefOid === tree.sha, checks } : null,
    evidence: evidence ?? null, agents: agents.filter(a => a.cwd === tree.path).map(a => ({ status: a.agent_status ?? "unknown", pane: a.pane_id ?? "unknown" })) });
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), worktrees: snapshot, limitations: "Read only. Local evidence is offline; absent PR checks/evidence are unknown, not passing. No deployment identity or provider journey checked." }, null, 2));
