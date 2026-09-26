import { MAX_DURATION_MS, MAX_UPLOAD_BYTES } from "./media.ts";

/** Require a decoded frame in this browser before uploading; FFmpeg alone is not an editor preview. */
export async function preflightBrowserVideo(file: File, mimeType: "video/mp4" | "video/webm"): Promise<void> {
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) throw new Error("Choose a video under 5 GiB.");
  const video = document.createElement("video");
  if (!video.canPlayType(mimeType)) throw new Error("This browser cannot preview the video format. Convert to H.264/AAC MP4.");
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Preview timed out. Try a browser-playable H.264/AAC MP4.")), 15_000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error("This video cannot be previewed in your browser. Convert to H.264/AAC MP4.")); };
      video.src = url;
      video.load();
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration * 1000 > MAX_DURATION_MS) {
      throw new Error("Choose a video no longer than 2 hours.");
    }
  } finally {
    video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
  }
}
