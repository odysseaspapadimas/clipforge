import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", timeout: 120_000, workers: 1,
  use: { baseURL: "http://127.0.0.1:5173", ...devices["Desktop Chrome"], headless: true },
  webServer: [
    { command: "mkdir -p .local-dev && bun run dev > .local-dev/vite-e2e.log 2>&1", url: "http://127.0.0.1:5173", reuseExistingServer: false, timeout: 30_000 },
    { command: "mkdir -p .local-dev && bun run dev:renderer > .local-dev/renderer-e2e.log 2>&1", url: "http://127.0.0.1:8080/health", reuseExistingServer: false, timeout: 30_000 },
  ],
  reporter: "list",
});
