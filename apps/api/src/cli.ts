import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { GraphNode, ImpactResult } from "@relic/graph-core";
import { buildApp, type RelicApp } from "./app";
import { evaluateBoundaries, loadBoundaryConfig } from "./check";
import { diffSnapshots, type SnapshotLike } from "./diff";
import { exportGraph, type ExportFormat } from "./export";
import { initProject } from "./init";
import { collectPrImpact, formatPrImpact } from "./pr";
import { startWatcher } from "./watch";

/**
 * relic — one command for the dashboard: indexes the given path (default:
 * cwd) into the shared graph DB, serves the API + built UI, opens a browser.
 *
 *   relic [path] [--port 8787] [--db <graph.db>] [--no-open] [--watch]
 *   relic index [path] [--db <graph.db>]
 *   relic impact <symbol> [--path <repo>] [--depth 5] [--json] [--indirect]
 *   relic export [--path <repo>] [--format mermaid|dot]
 *   relic check [--path <repo>] [--config <file>] [--json]
 *   relic pr [--path <repo>] [--base <rev>] [--head <rev>] [--json]
 *   relic init [path] [--force]
 *   relic diff a.json b.json [--check]
 */
type Mode = "serve" | "index" | "diff" | "impact" | "export" | "check" | "init" | "pr";

const MODES: Mode[] = ["index", "diff", "impact", "export", "check", "init", "pr"];

interface CliOptions {
  mode: Mode;
  root: string;
  port: number;
  dbPath: string;
  open: boolean;
  watch: boolean;
  check: boolean;
  diffFiles: string[];
  symbol: string | null;
  format: ExportFormat;
  config: string | null;
  json: boolean;
  depth: number;
  includeTests: boolean;
  includeIndirect: boolean;
  base: string | null;
  head: string | null;
  force: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    mode: "serve",
    root: process.cwd(),
    port: Number(process.env.PORT ?? 8787),
    dbPath: process.env.RELIC_DB ?? join(tmpdir(), "relic.db"),
    open: true,
    watch: false,
    check: false,
    diffFiles: [],
    symbol: null,
    format: "mermaid",
    config: null,
    json: false,
    depth: 5,
    includeTests: true,
    includeIndirect: false,
    base: null,
    head: null,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (MODES.includes(arg as Mode)) opts.mode = arg as Mode;
    else if (arg === "--port") opts.port = Number(argv[++i]);
    else if (arg === "--db") opts.dbPath = argv[++i] ?? opts.dbPath;
    else if (arg === "--path") opts.root = argv[++i] ?? opts.root;
    else if (arg === "--config") opts.config = argv[++i] ?? null;
    else if (arg === "--format") opts.format = (argv[++i] as ExportFormat) ?? "mermaid";
    else if (arg === "--depth") {
      const value = Number(argv[++i]);
      opts.depth = Number.isFinite(value) ? value : 5;
    } else if (arg === "--base") opts.base = argv[++i] ?? null;
    else if (arg === "--head") opts.head = argv[++i] ?? null;
    else if (arg === "--no-open") opts.open = false;
    else if (arg === "--watch") opts.watch = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--no-tests") opts.includeTests = false;
    else if (arg === "--tests") opts.includeTests = true;
    else if (arg === "--indirect") opts.includeIndirect = true;
    else if (arg === "--force") opts.force = true;
    else if (!arg.startsWith("-")) {
      if (opts.mode === "diff") opts.diffFiles.push(arg);
      else if (opts.mode === "impact" && !opts.symbol) opts.symbol = arg;
      else opts.root = arg;
    }
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

function formatImpact(impact: ImpactResult): string {
  const target = impact.target.qualifiedName ?? impact.target.name;
  const lines = [
    `Impact of ${target}: risk ${impact.summary.risk.score}/100`,
    `${impact.affected.length} affected node(s), ${impact.summary.affectedSymbols} symbol(s), ` +
      `${impact.summary.affectedTests} test(s), max depth ${impact.summary.maxDepth}`,
  ];
  for (const direction of ["upstream", "downstream"] as const) {
    const rows = impact.affected.filter((row) => row.direction === direction);
    if (rows.length === 0) continue;
    lines.push("", direction === "upstream" ? "Upstream:" : "Downstream:");
    for (const row of rows.slice(0, 50)) {
      const location = row.evidence.file
        ? ` · ${row.evidence.file}${row.evidence.line ? `:${row.evidence.line}` : ""}`
        : "";
      lines.push(
        `  ${row.node.qualifiedName ?? row.node.name} — ${row.relationship} · d${row.depth} · ` +
          `${Math.round(row.confidence * 100)}%${location}`,
      );
    }
    if (rows.length > 50) lines.push(`  …and ${rows.length - 50} more`);
  }
  return `${lines.join("\n")}\n`;
}

function resolveSymbol(app: RelicApp, repositoryId: string, symbol: string) {
  const matches = app.graph.graph.searchSymbols(repositoryId, symbol);
  const exact = matches.filter((m) => m.name === symbol || m.qualifiedName === symbol);
  const pick = exact.length > 0 ? exact : matches.length === 1 ? matches : [];
  if (pick.length === 0) {
    const hint =
      matches.length > 1
        ? `ambiguous; matches: ${matches
            .slice(0, 5)
            .map((m) => m.qualifiedName ?? m.name)
            .join(", ")}`
        : "no matching symbol";
    throw new Error(`Cannot resolve "${symbol}" (${hint})`);
  }
  return pick[0]!;
}

function reportError(context: string, err: unknown): void {
  console.error(`${context}:`, err instanceof Error ? err.message : err);
  process.exitCode = 1;
}

const opts = parseArgs(process.argv.slice(2));
const { mode, root, port, dbPath, open } = opts;

if (mode === "diff") {
  const [beforePath, afterPath] = opts.diffFiles;
  if (!beforePath || !afterPath) {
    console.error("usage: relic diff <before.json> <after.json> [--check]");
    process.exitCode = 1;
  } else {
    try {
      const before = JSON.parse(readFileSync(beforePath, "utf8")) as SnapshotLike;
      const after = JSON.parse(readFileSync(afterPath, "utf8")) as SnapshotLike;
      const diff = diffSnapshots(before, after);
      process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
      if (opts.check && diff.drift) process.exitCode = 1;
    } catch (err) {
      reportError("diff failed", err);
    }
  }
} else if (mode === "index") {
  const app = buildApp({ dbPath });
  try {
    process.stdout.write(`${JSON.stringify(app.graph.indexer.index(root), null, 2)}\n`);
  } catch (err) {
    reportError("index failed", err);
  } finally {
    app.graph.close();
  }
} else if (mode === "impact") {
  const app = buildApp({ dbPath });
  try {
    if (!opts.symbol) throw new Error("usage: relic impact <symbol> [--path <repo>]");
    const indexed = app.graph.indexer.index(root);
    const target = resolveSymbol(app, indexed.repositoryId, opts.symbol);
    const impact = app.graph.graph.analyzeImpact(indexed.repositoryId, target.id, {
      maxDepth: opts.depth,
      includeTests: opts.includeTests,
      includeIndirect: opts.includeIndirect,
    });
    process.stdout.write(opts.json ? `${JSON.stringify(impact, null, 2)}\n` : formatImpact(impact));
  } catch (err) {
    reportError("impact failed", err);
  } finally {
    app.graph.close();
  }
} else if (mode === "export") {
  const app = buildApp({ dbPath });
  try {
    if (opts.format !== "mermaid" && opts.format !== "dot")
      throw new Error(`Unknown format: ${opts.format} (expected mermaid or dot)`);
    const indexed = app.graph.indexer.index(root);
    const snapshot = app.graph.repository.snapshot(indexed.repositoryId);
    if (!snapshot) throw new Error(`Repository not indexed: ${indexed.repositoryId}`);
    process.stdout.write(exportGraph(opts.format, snapshot.nodes, snapshot.edges));
  } catch (err) {
    reportError("export failed", err);
  } finally {
    app.graph.close();
  }
} else if (mode === "check") {
  const app = buildApp({ dbPath });
  try {
    const indexed = app.graph.indexer.index(root);
    const config = loadBoundaryConfig(root, opts.config ?? undefined);
    if (!config) {
      throw new Error("No boundary config found. Create .relicrc.json or pass --config <file>.");
    }
    const edges = app.graph.repository.getEdges({
      repositoryId: indexed.repositoryId,
      limit: 100_000,
    });
    const cache = new Map<string, GraphNode | null>();
    const nodeById = (id: string) => {
      if (!cache.has(id)) cache.set(id, app.graph.repository.getNode(id));
      return cache.get(id) ?? null;
    };
    const violations = evaluateBoundaries(edges, nodeById, config.rules);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            source: config.source,
            rules: config.rules.length,
            checkedEdges: edges.length,
            violations: violations.map((violation) => ({
              rule: violation.rule.message ?? `${violation.rule.from} -> ${violation.rule.to}`,
              from: violation.fromFile,
              to: violation.toFile,
              type: violation.edge.type,
              evidence: violation.edge.evidence,
            })),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      console.log(
        `relic check: ${violations.length} violation(s) across ${config.rules.length} rule(s) [${config.source}]`,
      );
      for (const violation of violations) {
        const evidence = violation.edge.evidence.file
          ? ` at ${violation.edge.evidence.file}${violation.edge.evidence.line ? `:${violation.edge.evidence.line}` : ""}`
          : "";
        console.log(
          `  ✗ ${violation.rule.message ?? `${violation.rule.from} -> ${violation.rule.to}`}`,
        );
        console.log(
          `    ${violation.fromFile} -> ${violation.toFile} (${violation.edge.type})${evidence}`,
        );
      }
    }
    if (violations.length > 0) process.exitCode = 1;
  } catch (err) {
    reportError("check failed", err);
  } finally {
    app.graph.close();
  }
} else if (mode === "init") {
  try {
    process.stdout.write(`${JSON.stringify(initProject(root, { force: opts.force }), null, 2)}\n`);
  } catch (err) {
    reportError("init failed", err);
  }
} else if (mode === "pr") {
  const app = buildApp({ dbPath });
  try {
    const indexed = app.graph.indexer.index(root);
    const report = collectPrImpact(
      app.graph.graph,
      app.graph.repository,
      indexed.repositoryId,
      root,
      opts.base ?? undefined,
      opts.head ?? undefined,
    );
    process.stdout.write(
      opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatPrImpact(report),
    );
  } catch (err) {
    reportError("pr failed", err);
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

  if (opts.watch) startWatcher(app, root);

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
    const docsDir = join(dist, "docs");
    if (existsSync(join(docsDir, "index.html"))) {
      app.use("/docs/*", serveStatic({ root: dist }));
      app.get("/docs", (c) => c.redirect("/docs/"));
      app.get(
        "/docs/",
        () =>
          new Response(readFileSync(join(docsDir, "index.html")), {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      );
    } else {
      console.error("docs not built — run `bun run build` (docs will be served at /docs/)");
    }
  } else {
    console.error("dashboard not built — run `bun run build` (serving API only)");
  }

  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  console.error(`relic running at http://127.0.0.1:${port}`);
  if (open) openBrowser(`http://127.0.0.1:${port}`);
}
