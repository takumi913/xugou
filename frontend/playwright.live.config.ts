import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-live",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4174",
    colorScheme: "dark",
    locale: "zh-CN",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm run build && ./scripts/start-live-e2e.sh",
    url: "http://127.0.0.1:4174/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium-live", use: { browserName: "chromium" } }],
});
