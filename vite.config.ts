import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ command }) => ({
  plugins: [tanstackStart(), viteReact()],
  resolve: command === "serve" ? { alias: { "cloudflare:workers": fileURLToPath(new URL("./src/server/dev-cloudflare.ts", import.meta.url)) } } : undefined,
  server: { host: "127.0.0.1", port: 5173 },
  build: { rolldownOptions: { external: ["cloudflare:workers"] } },
}));
