const PART_BYTES = 8 * 1024 * 1024;
export const MAX_RENDER_BYTES = 512 * 1024 * 1024;

/** Cloudflare Container responses may be chunked and omit Content-Length. Keep
 * Worker memory bounded while uploading a validated MP4 to private R2. */
export async function storeRenderedMp4(media: R2Bucket, key: string, stream: ReadableStream<Uint8Array>, declaredLength: string | null): Promise<number> {
  const expected = declaredLength === null ? null : Number(declaredLength);
  if (expected !== null && (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_RENDER_BYTES)) {
    throw new Error("render_size_invalid");
  }
  const reader = stream.getReader();
  const multipart = await media.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } });
  const parts: R2UploadedPart[] = [];
  const buffer = new Uint8Array(PART_BYTES);
  let filled = 0, total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("render_size_invalid");
      total += value.byteLength;
      if (total > MAX_RENDER_BYTES || (expected !== null && total > expected)) throw new Error("render_size_invalid");
      for (let cursor = 0; cursor < value.byteLength;) {
        const length = Math.min(PART_BYTES - filled, value.byteLength - cursor);
        buffer.set(value.subarray(cursor, cursor + length), filled);
        filled += length;
        cursor += length;
        if (filled === PART_BYTES) {
          parts.push(await multipart.uploadPart(parts.length + 1, buffer));
          filled = 0;
        }
      }
    }
    if (total === 0 || (expected !== null && total !== expected)) throw new Error("render_size_invalid");
    if (filled > 0) parts.push(await multipart.uploadPart(parts.length + 1, buffer.subarray(0, filled)));
    await multipart.complete(parts);
    return total;
  } catch (error) {
    await reader.cancel().catch(() => {});
    await multipart.abort().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
