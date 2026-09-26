import { expect, test } from "bun:test";
import { readJson } from "../src/server/json.ts";

function request(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("https://clipforge-staging-web.account.workers.dev/api/uploads", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

test("accepts bounded JSON and rejects misleading or absent body lengths", async () => {
  expect(await readJson(request('{"name":"video"}', { "content-type": "application/json; charset=utf-8" })))
    .toEqual({ name: "video" });
  await expect(readJson(request("{}", { "content-length": "999999" }))).rejects.toThrow("Request too large");
  await expect(readJson(request("{}", { "content-type": "application/json-malformed" }))).rejects.toThrow("Expected JSON");
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(128_001)); controller.close(); },
  });
  await expect(readJson(request(oversized, { "content-length": "2" }))).rejects.toThrow("Request too large");
});
