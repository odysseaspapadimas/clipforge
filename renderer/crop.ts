export type CropRect = { width: number; height: number; left: number; top: number };
/** Pixel crop shared by FFmpeg and the browser. Dimensions are display-oriented (after autorotation). */
export function cropRect(width: number, height: number, cropX: number, cropY: number, zoom: number): CropRect {
  const baseW = Math.min(width, height * 9 / 16);
  const baseH = baseW * 16 / 9;
  const rectW = Math.max(2, Math.floor(baseW * 1000 / zoom / 2) * 2);
  const rectH = Math.max(2, Math.floor(baseH * 1000 / zoom / 2) * 2);
  const left = Math.min(Math.floor((width - rectW) / 2) * 2, Math.round((width - rectW) * cropX / 2000) * 2);
  const top = Math.min(Math.floor((height - rectH) / 2) * 2, Math.round((height - rectH) * cropY / 2000) * 2);
  return { width: rectW, height: rectH, left: Math.max(0, left), top: Math.max(0, top) };
}
/** Stretch the exact crop into the 9:16 viewport, just as FFmpeg's scale filter does. */
export function previewCropStyle(width: number, height: number, cropX: number, cropY: number, zoom: number) {
  const rect = cropRect(width, height, cropX, cropY, zoom);
  return { width: `${100 * width / rect.width}%`, height: `${100 * height / rect.height}%`,
    left: `${-100 * rect.left / rect.width}%`, top: `${-100 * rect.top / rect.height}%` };
}
