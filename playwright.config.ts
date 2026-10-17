import { defineConfig, devices } from "@playwright/test";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fully isolated from a running dev stack: e2e uses its own API port + fresh
// database (the first spec starts from the empty state) and its own vite on
// 5174 proxying to that API — dev servers on 8787/5173 are left alone.
const API_PORT = 8790;
const WEB_PORT = 5174;
const apiUrl = `http://127.0.0.1:${API_PORT}`;
const dbPath = join(tmpdir(), `mcpdg-e2e-${process.pid}.db`);
try {
  for (const f of readdirSync(tmpdir())) {
    if (f.startsWith("mcpdg-e2e-") && f.endsWith(".db")) rmSync(join(tmpdir(), f), { force: true });
  }
} catch {
  // best effort — a stale tmp db is not worth failing the run for
}

export default defineConfig({
  // .e2e.ts (not .spec/.test) so `bun test` never picks these files up
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: "bun run dev:api",
      url: `${apiUrl}/api/repositories`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { PORT: String(API_PORT), MCP_GRAPH_DB: dbPath },
    },
    {
      command: `vite apps/dashboard --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { MCPDG_API_URL: apiUrl },
    },
  ],
});
