import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
// Pi loads project extensions through a module loader where import.meta.dir is unavailable.
// Extension discovery starts in the selected checkout, so use its process cwd.
const root = process.cwd();
async function snapshot(): Promise<string[]> {
  const child = Bun.spawn(["bun", "scripts/inspect.ts"], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) return ["Inspector unavailable; run bun scripts/inspect.ts for diagnostics."];
  const data = JSON.parse(text);
  const lines = [`Snapshot ${data.generatedAt} (read-only)`, ""];
  for (const tree of data.worktrees) {
    lines.push(`${tree.branch}  ${tree.sha.slice(0, 12)}  ${tree.dirty ? "DIRTY" : "clean"}`);
    lines.push(`  ${tree.path}`);
    if (tree.pr) {
      lines.push(`  PR #${tree.pr.number} ${tree.pr.draft ? "draft" : "open"} ${tree.pr.headMatches ? "HEAD matched" : "HEAD MISMATCH"}: ${tree.pr.title}`);
      for (const check of tree.pr.checks) lines.push(`    CI ${check.name}: ${check.status}`);
      if (!tree.pr.checks.length) lines.push("    CI not reported (not a pass)");
    } else lines.push("  No open PR");
    lines.push(`  Local evidence: ${tree.evidence ? `${tree.evidence.outcome} (${tree.evidence.scope}, ${tree.evidence.createdAt})` : "not found for exact SHA"}`);
    for (const agent of tree.agents) lines.push(`  Herdr ${agent.pane}: ${agent.status}`);
    lines.push("");
  }
  lines.push(data.limitations);
  return lines;
}

class Inspector {
  private lines: string[] = ["Loading..."];
  private offset = 0;
  private rows: number;
  constructor(private tui: TUI, private theme: Theme, private close: () => void) {
    this.rows = Math.max(5, tui.terminal.rows - 8);
    void this.refresh();
  }
  private async refresh() {
    try { this.lines = await snapshot(); } catch { this.lines = ["Inspector unavailable; try bun scripts/inspect.ts."]; }
    this.offset = 0;
    this.tui.requestRender();
  }
  handleInput(key: string) {
    if (matchesKey(key, "escape") || key === "q") return this.close();
    if (key === "r") { void this.refresh(); return; }
    const max = Math.max(0, this.lines.length - this.rows);
    if (matchesKey(key, "up") || key === "k") this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(key, "down") || key === "j") this.offset = Math.min(max, this.offset + 1);
    else if (matchesKey(key, "pageUp")) this.offset = Math.max(0, this.offset - this.rows);
    else if (matchesKey(key, "pageDown")) this.offset = Math.min(max, this.offset + this.rows);
    else return;
    this.tui.requestRender();
  }
  render(width: number) {
    if (width < 8) return ["Inspector"];
    const maxWidth = width - 2;
    const fit = (text: string) => truncateToWidth(text, maxWidth, "…", true);
    return [this.theme.fg("accent", fit(" Clipforge /inspect — SHA, CI, evidence, Herdr ")),
      ...this.lines.slice(this.offset, this.offset + this.rows).map(fit),
      this.theme.fg("dim", fit(` ↑↓/jk scroll  PgUp/PgDn  r refresh  q/Esc close  ${this.offset + 1}/${this.lines.length}`))];
  }
}
export default function clipforgeInspect(pi: ExtensionAPI) {
  pi.registerCommand("inspect", {
    description: "Read-only Clipforge worktree, PR, evidence and Herdr inspection",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/inspect needs an interactive TUI; use bun scripts/inspect.ts", "warning"); return; }
      await ctx.ui.custom<void>((tui, theme, _keys, done) => new Inspector(tui, theme, () => done()),
        { overlay: true, overlayOptions: { anchor: "center", width: "90%", minWidth: 48, maxHeight: "85%", margin: 1 } });
    },
  });
}
