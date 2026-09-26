// Bound JSON request bodies even if Content-Length is missing or dishonest.
export async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new Error("Expected JSON");
  }
  const maximum = 128_000;
  const advertised = request.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maximum)) {
    throw new Error("Request too large");
  }
  if (!request.body) throw new Error("Expected JSON body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel("Request too large");
        throw new Error("Request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
}
