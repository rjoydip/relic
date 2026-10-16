#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic } from "hono/bun";
import { buildApp } from "./app";

/**
 * mcpdg — one command for the dashboard: indexes the given path (default:
 * cwd) into the shared graph DB, serves the API + built UI, opens a browser.
 *
 *   mcpdg [path] [--port 8787] [--db <graph.db>] [--no-open]
 */
function parseArgs(argv: string[]): { root: string; port: number; dbPath: string; open: boolean } {
  const opts = {
    root: process.cwd(),
    port: Number(process.env.PORT ?? 8787),
    dbPath: process.env.MCP_GRAPH_DB ?? join(tmpdir(), "mcpdg-graph.db"),
    open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") opts.port = Number(argv[++i]);
    else if (arg === "--db") opts.dbPath = argv[++i] ?? opts.dbPath;
    else if (arg === "--no-open") opts.open = false;
    else if (arg && !arg.startsWith("-")) opts.root = arg;
  }
  return opts;
}

function openBrowser(url: string): void {
  const argv =
    process.platform === "win32"
      ? ["cmd", "/c", "start", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

const { root, port, dbPath, open } = parseArgs(process.argv.slice(2));
const app = buildApp({ dbPath });

try {
  const result = app.graph.indexer.index(root);
  console.error(
    `indexed ${root}: ${result.nodeCount} nodes, ${result.edgeCount} edges (${result.analyzedFiles}/${result.totalFiles} files)`,
  );
} catch (err) {
  console.error(`auto-index skipped for ${root}:`, err instanceof Error ? err.message : err);
}

// ponytail: serves the prebuilt dashboard; run `bun run build` once so
// apps/dashboard/dist exists. Swap for vite dev middleware if HMR matters.
const dist = join(import.meta.dir, "..", "..", "dashboard", "dist");
if (existsSync(dist)) {
  app.use("/assets/*", serveStatic({ root: dist }));
  app.get(
    "/",
    () =>
      new Response(Bun.file(join(dist, "index.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  );
} else {
  console.error("dashboard not built — run `bun run build` (serving API only)");
}

Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
console.error(`mcpdg running at http://127.0.0.1:${port}`);
if (open) openBrowser(`http://127.0.0.1:${port}`);
