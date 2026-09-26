import { describe, expect, mock, test } from "bun:test";
import type { ProcessorEnv } from "../alchemy.run.ts";

mock.module("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
mock.module("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => { throw new Error("Container not called"); } }));
const { default: processor, rankCandidates } = await import("../src/workers/processor.ts");

function fixture(initialStatus: string, currentRevision = 1, projectStatus = "ready") {
  let status = initialStatus, workflowState = "errored", restarts = 0;
  const instance = { id: "export-known", status: async () => ({ status: workflowState }),
    restart: async (options?: unknown) => {
      expect(options).toBeUndefined(); restarts++; workflowState = "running";
    } };
  const env = { INTERNAL_SECRET: "unit-test-secret", EXPORT: {
    create: async () => { throw new Error("Workflow ID already exists"); },
    get: async () => instance,
  }, DB: { prepare: (query: string) => ({ bind: (..._values: unknown[]) => ({
    first: async () => query.includes("SELECT j.status") ? { status, revision: 1, current_revision: currentRevision, project_status: projectStatus } : null,
    run: async () => { if (query.includes("status = 'queued'") && status === "failed") {
      status = "queued"; return { meta: { changes: 1 } };
    } return { meta: { changes: 0 } }; },
  }) }) } } as unknown as ProcessorEnv;
  const request = () => new Request("https://internal/internal/export", { method: "POST",
    headers: { "x-clipforge-internal": "unit-test-secret" },
    body: JSON.stringify({ jobId: "5277584a-0fcb-4a3c-a6a8-fe372aa2bdd7" }) });
  return { env, request, get restarts() { return restarts; } };
}
test("a valid empty/invalid model ranking falls back instead of failing ingest", async () => {
  const suggestions = Array.from({ length: 9 }, (_, index) => ({
    title: `Suggestion ${index}`, startMs: index * 10_000, endMs: index * 10_000 + 9_000, rationale: "Local", score: 50,
  }));
  for (const picks of [[], [{ id: 999, title: "Invalid", rationale: "No" }]]) {
    const env = { AI: { run: async () => ({ response: JSON.stringify({ picks }) }) } } as unknown as ProcessorEnv;
    expect((await rankCandidates(env, suggestions, [])).map((item) => item.title))
      .toEqual(suggestions.slice(0, 8).map((item) => item.title));
  }
});
describe("export workflow retry", () => {
  test("restarts a failed revision exactly once and does not restart running work", async () => {
    const f = fixture("failed");
    expect((await processor.fetch(f.request(), f.env)).status).toBe(202);
    expect(f.restarts).toBe(1);
    expect((await processor.fetch(f.request(), f.env)).status).toBe(202);
    expect(f.restarts).toBe(1);
  });
  test("will not restart a job after its project is being deleted", async () => {
    const f = fixture("failed", 1, "deleting");
    expect((await processor.fetch(f.request(), f.env)).status).toBe(409);
    expect(f.restarts).toBe(0);
  });
  test("rejects retry of a clip revision that changed since the render job", async () => {
    const f = fixture("failed", 2);
    expect((await processor.fetch(f.request(), f.env)).status).toBe(409);
    expect(f.restarts).toBe(0);
  });
});
