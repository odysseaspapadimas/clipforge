import { expect, test } from "bun:test";
import { localEnvIsSafe, worktrees } from "../scripts/session-preflight.ts";

test("preflight parses only live named or detached Git worktrees", () => {
  expect(worktrees("worktree /code/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /code/feature\nHEAD def\nbranch refs/heads/feat/captions\n\nworktree /code/stale\nHEAD 123\nprunable gitdir file points to non-existent location\n\nworktree /code/review\nHEAD 999\ndetached\n")).toEqual([
    { path: "/code/main", branch: "main" }, { path: "/code/feature", branch: "feat/captions" }, { path: "/code/review", branch: "detached" },
  ]);
});

test("local env gate rejects privileged credentials and invalid or overlapping ports", () => {
  const local = { CLIPFORGE_DEV_PORT: "25173", CLIPFORGE_RENDERER_PORT: "35173" };
  expect(localEnvIsSafe(local)).toBe(true);
  for (const key of ["ALCHEMY_STAGE", "STRIPE_API_KEY", "CLIPFORGE_AUTH_SECRET", "CLIPFORGE_INTERNAL_SECRET", "CLIPFORGE_DEEPGRAM_KEY", "CLIPFORGE_EMAIL_API_KEY"]) {
    expect(localEnvIsSafe({ ...local, [key]: "set" })).toBe(false);
  }
  expect(localEnvIsSafe({ ...local, CLIPFORGE_RENDERER_PORT: local.CLIPFORGE_DEV_PORT })).toBe(false);
  expect(localEnvIsSafe({ ...local, CLIPFORGE_DEV_PORT: "1.2" })).toBe(false);
  expect(localEnvIsSafe({ ...local, CLIPFORGE_DEV_PORT: "0" })).toBe(false);
  expect(localEnvIsSafe({ ...local, CLIPFORGE_DEV_PORT: "65536" })).toBe(false);
});
