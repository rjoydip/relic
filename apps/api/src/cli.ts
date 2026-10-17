import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildApp } from "./app";

/**
 * skein — one command for the dashboard: indexes the given path (default:
 * cwd) into the shared graph DB, serves the API + built UI, opens a browser.
 *
 *   skein [path] [--port 8787] [--db <graph.db>] [--no-open]   serve (default)
 *   skein index [path] [--db <graph.db>]                        one-shot for
 *                                                                agents: index,
 *                                                                print JSON to
 *                                                                stdout, exit
 */
function parseArgs(argv: string[]): {
  mode: "serve" | "index";
  root: string;
  port: number;
  dbPath: string;
  open: boolean;
} {
  const opts: {
    mode: "serve" | "index";
    root: string;
    port: number;
    dbPath: string;
    open: boolean;
  } = {
    mode: "serve",
    root: process.cwd(),
    port: Number(process.env.PORT ?? 8787),
    dbPath: process.env.SKEIN_DB ?? join(tmpdir(), "skein.db"),
    open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "index") opts.mode = "index";
    else if (arg === "--port") opts.port = Number(argv[++i]);
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
  spawn(argv[0]!, argv.slice(1), { stdio: "ignore", detached: true }).unref();
}

/** Prebuilt dashboard: bundled at dist/dashboard, or apps/dashboard/dist in dev. */
function dashboardDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "dashboard"), // published: <pkg>/dist/dashboard
    join(here, "..", "..", "dashboard", "dist"), // dev: apps/dashboard/dist
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const { mode, root, port, dbPath, open } = parseArgs(process.argv.slice(2));

if (mode === "index") {
  // One-shot for agents and scripts: index, emit IndexResult as JSON on
  // stdout, exit non-zero on failure (all logs stay on stderr).
  const app = buildApp({ dbPath });
  try {
    process.stdout.write(`${JSON.stringify(app.graph.indexer.index(root), null, 2)}\n`);
  } catch (err) {
    console.error("index failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    app.graph.close();
  }
} else {
  const app = buildApp({ dbPath });

  try {
    const result = app.graph.indexer.index(root);
    console.error(
      `indexed ${root}: ${result.nodeCount} nodes, ${result.edgeCount} edges (${result.analyzedFiles}/${result.totalFiles} files)`,
    );
  } catch (err) {
    console.error(`auto-index skipped for ${root}:`, err instanceof Error ? err.message : err);
  }

  const dist = dashboardDir();
  if (dist) {
    app.use("/assets/*", serveStatic({ root: dist }));
    app.get(
      "/",
      () =>
        new Response(readFileSync(join(dist, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
  } else {
    console.error("dashboard not built — run `bun run build` (serving API only)");
  }

  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  console.error(`skein running at http://127.0.0.1:${port}`);
  if (open) openBrowser(`http://127.0.0.1:${port}`);
}
