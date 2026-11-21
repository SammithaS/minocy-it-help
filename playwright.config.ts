/**
 * End-to-end tests (Playwright) against the real app on `pnpm dev` (local D1 + your Cloudflare
 * account's Vectorize / Workers AI / Gemini key, like day-to-day dev).
 *
 *   pnpm db:reset && pnpm e2e      # stop any running `pnpm dev` first — Playwright starts its own
 *
 * Uses the Microsoft Edge that ships with Windows (`channel: "msedge"`), so no browser download.
 * Set E2E_CHANNEL=chrome (or chromium after `pnpm exec playwright install chromium`) elsewhere.
 * Sign-in codes are read from the dev server's log, the same place a developer reads them.
 */
import { defineConfig } from "@playwright/test";

export const DEV_LOG = ".wrangler/e2e-dev.log";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5173",
    channel: process.env.E2E_CHANNEL ?? "msedge",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `pnpm dev --strictPort > ${DEV_LOG} 2>&1`,
    url: "http://localhost:5173/api/health",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
