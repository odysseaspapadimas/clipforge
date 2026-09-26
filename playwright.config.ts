import { defineConfig, devices } from "@playwright/test";

const sitePort = Number(process.env.CLIPFORGE_DEV_PORT ?? 5173);
const rendererPort = Number(process.env.CLIPFORGE_RENDERER_PORT ?? 8080);
export default defineConfig({
  testDir: "./e2e", timeout: 120_000, workers: 1,
  use: { baseURL: `http://127.0.0.1:${sitePort}`, ...devices["Desktop Chrome"], headless: true },
  webServer: [
    { command: `mkdir -p .local-dev && CLIPFORGE_DEV_ORIGIN=http://127.0.0.1:${sitePort} bun run dev --port ${sitePort} > .local-dev/vite-e2e.log 2>&1`, url: `http://127.0.0.1:${sitePort}`, reuseExistingServer: false, timeout: 30_000 },
    { command: `mkdir -p .local-dev && PORT=${rendererPort} bun run dev:renderer > .local-dev/renderer-e2e.log 2>&1`, url: `http://127.0.0.1:${rendererPort}/health`, reuseExistingServer: false, timeout: 30_000 },
  ],
  reporter: "list",
});
