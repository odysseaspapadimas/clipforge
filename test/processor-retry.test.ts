import { describe, expect, mock, test } from "bun:test";
import type { ProcessorEnv } from "../alchemy.run.ts";

mock.module("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
mock.module("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => { throw new Error("Container not called"); } }));
const { default: processor } = await import("../src/workers/processor.ts");

function fixture(initialStatus: string, currentRevision = 1) {
  let status = initialStatus, workflowState = "errored", restarts = 0;
  const instance = { id: "export-known", status: async () => ({ status: workflowState }),
    restart: async (options?: unknown) => {
      expect(options).toBeUndefined(); restarts++; workflowState = "running";
    } };
  const env = { INTERNAL_SECRET: "unit-test-secret", EXPORT: {
    create: async () => { throw new Error("Workflow ID already exists"); },
    get: async () => instance,
  }, DB: { prepare: (query: string) => ({ bind: (..._values: unknown[]) => ({
    first: async () => query.includes("SELECT j.status") ? { status, revision: 1, current_revision: currentRevision } : null,
    run: async () => { if (query.includes("status = 'queued'") && status === "failed") {
      status = "queued"; return { meta: { changes: 1 } };
    } return { meta: { changes: 0 } }; },
  }) }) } } as unknown as ProcessorEnv;
  const request = () => new Request("https://internal/internal/export", { method: "POST",
    headers: { "x-clipforge-internal": "unit-test-secret" },
    body: JSON.stringify({ jobId: "5277584a-0fcb-4a3c-a6a8-fe372aa2bdd7" }) });
  return { env, request, get restarts() { return restarts; } };
}
describe("export workflow retry", () => {
  test("restarts a failed revision exactly once and does not restart running work", async () => {
    const f = fixture("failed");
    expect((await processor.fetch(f.request(), f.env)).status).toBe(202);
    expect(f.restarts).toBe(1);
    expect((await processor.fetch(f.request(), f.env)).status).toBe(202);
    expect(f.restarts).toBe(1);
  });
  test("rejects retry of a clip revision that changed since the render job", async () => {
    const f = fixture("failed", 2);
    expect((await processor.fetch(f.request(), f.env)).status).toBe(409);
    expect(f.restarts).toBe(0);
  });
});
