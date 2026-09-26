import * as Cloudflare from "alchemy/Cloudflare";
export const Database = Cloudflare.D1.Database("ClipforgeDatabase", { migrations: "./migrations" });
export const Media = Cloudflare.R2.Bucket("ClipforgePrivateMedia", {
  lifecycleRules: [
    { id: "abort-incomplete-upload", enabled: true, prefix: "users/",
      abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 2 * 24 * 60 * 60 } } },
    { id: "media-retention-90-days", enabled: true, prefix: "users/",
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 90 * 24 * 60 * 60 } } },
  ],
});
