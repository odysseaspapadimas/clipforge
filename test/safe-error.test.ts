import { expect, test } from "bun:test";
import { safeErrorCode } from "../src/domain/safe-error.ts";

test("keeps stable diagnostic codes without logging provider responses or customer data", () => {
  expect(safeErrorCode(new Error("staging_inference_budget_exhausted"))).toBe("staging_inference_budget_exhausted");
  expect(safeErrorCode(new Error("render_http_429"))).toBe("render_http_429");
  for (const message of ["API key sk_test_secret", "transcript: personal information",
    "https://example.com?token=sensitive", "x".repeat(128), "line\nbreak", { provider: "error" }]) {
    expect(safeErrorCode(message)).toBe("unclassified_error");
  }
});
