import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { GraphError } from "@relic/graph-core";
import type { EdgeType, GraphEdge, GraphNode, NodeType, RepositoryMeta } from "@relic/graph-core";
import { openGraph, repositoryIdFor, type OpenGraph } from "@relic/indexer";

export interface ApiOptions {
  dbPath: string;
  /** When set, repository paths must resolve inside one of these roots. */
  allowedRoots?: string[];
}

export interface GraphUpdateEvent {
  repositoryId: string;
  nodeCount: number;
  edgeCount: number;
  revision: string | null;
  indexedAt: string | null;
}

export type RelicApp = Hono & { graph: OpenGraph; events: EventEmitter };

const MAX_LIMIT = 5000;

/** Snapshot file: the full graph of one repository, portable between machines. */
interface SnapshotBody {
  format?: string;
  version?: number;
  repository?: {
    name?: string;
    rootPath?: string;
    lastRevision?: string | null;
    indexedAt?: string | null;
    durationMs?: number | null;
    fileCount?: number;
    diagnostics?: RepositoryMeta["diagnostics"];
  };
  nodes?: Array<{
    id: string;
    type: NodeType;
    name: string;
    qualifiedName?: string | null;
    filePath?: string | null;
    startLine?: number | null;
    endLine?: number | null;
  }>;
  edges?: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    type: EdgeType;
    confidence?: number;
    evidence?: GraphEdge["evidence"];
  }>;
}

function limitOf(raw: string | undefined, fallback = 50): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

const GITHUB_URL = /^https:\/\/github\.com\/([\w-][\w.-]*)\/([\w-][\w.-]*?)(?:\.git)?\/?$/;

/** Normalizes accepted GitHub URLs; anything else returns null (treated as a local path). */
export function parseGitHubUrl(raw: string): string | null {
  const match = GITHUB_URL.exec(raw.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/** Shallow-clones into a stable temp dir so re-indexing the same URL updates in place. */
function ensureGitHubClone(url: string): string {
  const dir = join(
    tmpdir(),
    "relic-github",
    createHash("sha1").update(url).digest("hex").slice(0, 12),
  );
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--single-branch", url, dir], {
      stdio: "pipe",
      timeout: 120_000,
    });
  } else {
    try {
      execFileSync("git", ["pull", "--ff-only"], { cwd: dir, stdio: "pipe", timeout: 60_000 });
    } catch {
      // offline or diverged: index the existing checkout
    }
  }
  return dir;
}

export function buildApp(options: ApiOptions): RelicApp {
  const store = openGraph(options.dbPath);
  const app = new Hono() as RelicApp;
  app.graph = store;
  app.events = new EventEmitter();
  app.events.setMaxListeners(0); // one listener per open SSE stream
  // the dashboard can be hosted separately (static Worker, Vite on another port)
  app.use("/api/*", cors());

  const fail = (
    c: { json: (body: unknown, status: number) => Response },
    err: unknown,
  ): Response => {
    if (err instanceof GraphError) {
      const status =
        err.code === "REPOSITORY_NOT_FOUND" || err.code === "NODE_NOT_FOUND" ? 404 : 400;
      return c.json({ error: err.code, message: err.message }, status);
    }
    return c.json(
      { error: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  };

  /** Accepts a repository ID or a filesystem path; enforces allowed roots. */
  const resolveRepo = (raw: string | undefined): string => {
    if (!raw) throw new GraphError("INVALID_INPUT", "repository is required");
    if (store.repository.getRepository(raw)) {
      const meta = store.repository.getRepository(raw)!;
      assertAllowed(meta.rootPath);
      return raw;
    }
    const root = resolve(raw);
    assertAllowed(root);
    return repositoryIdFor(root);
  };

  const assertAllowed = (root: string): void => {
    const roots = options.allowedRoots ?? [];
    if (roots.length === 0) return;
    const normalized = resolve(root);
    const ok = roots.some((allowed) => {
      const base = resolve(allowed);
      return normalized === base || normalized.startsWith(base + sep);
    });
    if (!ok) throw new GraphError("PATH_ESCAPE", `Repository path outside allowed roots: ${root}`);
  };

  const requireIndex = (id: string) => {
    const meta = store.repository.getRepository(id);
    if (!meta) throw new GraphError("REPOSITORY_NOT_FOUND", `Repository not indexed: ${id}`);
    return meta;
  };

  const indexAndNotify = (root: string, revision?: string | null) => {
    const result = store.indexer.index(root, revision !== undefined ? { revision } : {});
    const payload: GraphUpdateEvent = {
      repositoryId: result.repositoryId,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      revision: result.revision,
      indexedAt: new Date().toISOString(),
    };
    app.events.emit("graph-updated", payload);
    return result;
  };

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      const listener = (payload: GraphUpdateEvent): void => {
        void stream.writeSSE({
          event: "graph-updated",
          data: JSON.stringify(payload),
        });
      };
      app.events.on("graph-updated", listener);
      stream.onAbort(() => {
        closed = true;
        app.events.off("graph-updated", listener);
      });
      while (!closed) {
        await stream.sleep(20_000);
        if (closed) break;
        // keep-alive so proxies do not drop an idle stream
        await stream.writeSSE({ event: "ping", data: "{}" });
      }
    }),
  );

  app.get("/api/repositories", (c) =>
    c.json({ repositories: store.repository.listRepositories() }),
  );

  // Drop an indexed repository (snapshot cache) from the local store.
  app.delete("/api/repositories/:id", (c) => {
    try {
      const id = c.req.param("id");
      if (!store.repository.getRepository(id))
        throw new GraphError("REPOSITORY_NOT_FOUND", `Repository not indexed: ${id}`);
      store.repository.deleteRepository(id);
      return c.json({ deleted: id });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/repositories/:id/summary", (c) => {
    try {
      return c.json(store.graph.getSummary(c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/api/repositories/:id/index", async (c) => {
    try {
      const id = c.req.param("id");
      const meta = store.repository.getRepository(id);
      const body = await c.req.json<{ root?: string }>().catch(() => ({}) as { root?: string });
      const root = body.root ?? meta?.rootPath;
      if (!root) throw new GraphError("INVALID_INPUT", "repository root is required for indexing");
      assertAllowed(resolve(root));
      return c.json(indexAndNotify(root));
    } catch (err) {
      return fail(c, err);
    }
  });

  // Serves a repository file for the dashboard's content peek; paths are
  // repo-relative and must stay inside the repository root.
  app.get("/api/repositories/:id/file", (c) => {
    try {
      const meta = requireIndex(c.req.param("id"));
      const path = c.req.query("path");
      if (!path) throw new GraphError("INVALID_INPUT", "path is required");
      const abs = resolve(meta.rootPath, path);
      if (!abs.startsWith(meta.rootPath + sep))
        throw new GraphError("PATH_ESCAPE", `Path outside repository: ${path}`);
      if (!existsSync(abs)) throw new GraphError("INVALID_INPUT", `File not found: ${path}`);
      return c.json({ path, content: readFileSync(abs, "utf8") });
    } catch (err) {
      return fail(c, err);
    }
  });

  // Index any local path or GitHub URL; powers the dashboard's index form.
  app.post("/api/index", async (c) => {
    try {
      const body = await c.req.json<{ source?: string }>();
      const source = body.source?.trim();
      if (!source) throw new GraphError("INVALID_INPUT", "source is required");
      const github = parseGitHubUrl(source);
      let root: string;
      if (github) {
        // ponytail: shallow clone into temp with no size cap; add caps before
        // exposing this endpoint beyond localhost.
        if ((options.allowedRoots ?? []).length > 0)
          throw new GraphError("PATH_ESCAPE", "GitHub sources are outside allowedRoots");
        root = ensureGitHubClone(github);
      } else {
        root = resolve(source);
        assertAllowed(root);
      }
      return c.json(indexAndNotify(root));
    } catch (err) {
      return fail(c, err);
    }
  });

  // Full graph as a portable snapshot file (no pagination, unlike the UI APIs).
  app.get("/api/repositories/:id/snapshot", (c) => {
    try {
      const id = c.req.param("id");
      const snap = store.repository.snapshot(id);
      if (!snap) throw new GraphError("REPOSITORY_NOT_FOUND", `Repository not indexed: ${id}`);
      return c.json({
        format: "relic-snapshot",
        version: 1,
        repository: {
          name: snap.meta.name,
          rootPath: snap.meta.rootPath,
          lastRevision: snap.meta.lastRevision,
          indexedAt: snap.meta.indexedAt,
          durationMs: snap.meta.indexingDurationMs,
          fileCount: snap.meta.fileCount,
          diagnostics: snap.meta.diagnostics,
        },
        nodes: snap.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          name: n.name,
          qualifiedName: n.qualifiedName ?? null,
          filePath: n.filePath ?? null,
          startLine: n.startLine ?? null,
          endLine: n.endLine ?? null,
        })),
        edges: snap.edges.map((e) => ({
          id: e.id,
          sourceId: e.sourceId,
          targetId: e.targetId,
          type: e.type,
          confidence: e.confidence,
          evidence: e.evidence,
        })),
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  // Load a snapshot into the local store so the normal graph APIs can render it.
  app.post("/api/snapshot", async (c) => {
    try {
      const body = await c.req.json<SnapshotBody>();
      if (body.format !== "relic-snapshot" || body.version !== 1)
        throw new GraphError("INVALID_INPUT", "Unsupported snapshot format");
      const nodes = body.nodes ?? [];
      const edges = body.edges ?? [];
      if (!Array.isArray(nodes) || !Array.isArray(edges))
        throw new GraphError("INVALID_INPUT", "Snapshot nodes/edges must be arrays");

      const rootPath = body.repository?.rootPath ?? "";
      const id = repositoryIdFor(rootPath || body.repository?.name || "snapshot");
      const now = new Date().toISOString();
      const meta: RepositoryMeta = {
        id,
        name: body.repository?.name ?? "snapshot",
        rootPath,
        lastRevision: body.repository?.lastRevision ?? null,
        indexedAt: body.repository?.indexedAt ?? now,
        indexingDurationMs: body.repository?.durationMs ?? null,
        fileCount:
          body.repository?.fileCount ?? new Set(nodes.map((n) => n.filePath).filter(Boolean)).size,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        diagnostics: body.repository?.diagnostics ?? [],
      };
      const graphNodes: GraphNode[] = nodes.map((n) => ({
        id: n.id,
        repositoryId: id,
        type: n.type,
        name: n.name,
        qualifiedName: n.qualifiedName ?? null,
        filePath: n.filePath ?? null,
        startLine: n.startLine ?? null,
        endLine: n.endLine ?? null,
        metadata: {},
        contentHash: null,
        updatedAt: now,
      }));
      const graphEdges: GraphEdge[] = edges.map((e) => ({
        id: e.id,
        repositoryId: id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        type: e.type,
        confidence: e.confidence ?? 0.6,
        evidence: e.evidence ?? { source: "static" },
      }));

      // replaceRepositoryGraph is file-oriented: a file owns its nodes and its
      // outgoing edges, so bucket both by the source node's file path.
      const buckets = new Map<
        string,
        { filePath: string; nodes: GraphNode[]; edges: GraphEdge[] }
      >();
      const bucket = (filePath: string) => {
        let b = buckets.get(filePath);
        if (!b) {
          b = { filePath, nodes: [], edges: [] };
          buckets.set(filePath, b);
        }
        return b;
      };
      const nodeFile = new Map<string, string>();
      for (const n of graphNodes) {
        nodeFile.set(n.id, n.filePath ?? "");
        bucket(n.filePath ?? "").nodes.push(n);
      }
      for (const e of graphEdges) bucket(nodeFile.get(e.sourceId) ?? "").edges.push(e);

      store.repository.replaceRepositoryGraph({ meta, files: [...buckets.values()] });
      return c.json({
        repositoryId: id,
        nodeCount: graphNodes.length,
        edgeCount: graphEdges.length,
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/graph/nodes", (c) => {
    try {
      const repository = resolveRepo(c.req.query("repository"));
      const filter: Parameters<typeof store.repository.listNodes>[0] = {
        repositoryId: repository,
        limit: limitOf(c.req.query("limit")),
      };
      const type = c.req.query("type");
      if (type) filter.type = type as NodeType;
      const filePath = c.req.query("filePath");
      if (filePath) filter.filePath = filePath;
      const query = c.req.query("q");
      if (query) filter.query = query;
      const offset = Number(c.req.query("offset") ?? 0);
      if (Number.isFinite(offset) && offset >= 0) filter.offset = Math.floor(offset);
      return c.json({ nodes: store.repository.listNodes(filter) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/graph/edges", (c) => {
    try {
      const repository = resolveRepo(c.req.query("repository"));
      requireIndex(repository);
      const sourceId = c.req.query("sourceId");
      const targetId = c.req.query("targetId");
      const types = c.req.query("types");
      const filter: Parameters<typeof store.repository.getEdges>[0] = {
        limit: limitOf(c.req.query("limit"), 200),
        repositoryId: repository,
      };
      if (sourceId) filter.sourceIds = [sourceId];
      if (targetId) filter.targetIds = [targetId];
      if (types) filter.edgeTypes = types.split(",") as EdgeType[];
      return c.json({ edges: store.repository.getEdges(filter) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/graph/nodes/:id", (c) => {
    try {
      const node = store.repository.getNode(c.req.param("id"));
      if (!node) throw new GraphError("NODE_NOT_FOUND", `Node not found: ${c.req.param("id")}`);
      return c.json(node);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/graph/nodes/:id/neighborhood", (c) => {
    try {
      const id = c.req.param("id");
      const node = store.repository.getNode(id);
      if (!node) throw new GraphError("NODE_NOT_FOUND", `Node not found: ${id}`);
      const depth = Math.min(Math.max(Number(c.req.query("depth") ?? 1) || 1, 1), 4);
      const limit = limitOf(c.req.query("limit"), 200);
      const forward = store.repository.traverse({
        repositoryId: node.repositoryId,
        seedIds: [id],
        direction: "forward",
        maxDepth: depth,
        limit,
      });
      const reverse = store.repository.traverse({
        repositoryId: node.repositoryId,
        seedIds: [id],
        direction: "reverse",
        maxDepth: depth,
        limit,
      });
      const steps = [...reverse, ...forward];
      const ids = new Set([id, ...steps.map((s) => s.node.id)]);
      const nodes = [...ids]
        .map((n) => store.repository.getNode(n))
        .filter((n): n is NonNullable<typeof n> => n !== null);
      return c.json({ nodes, steps });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/api/impact", async (c) => {
    try {
      const body = await c.req.json<{
        repository?: string;
        nodeId?: string;
        symbol?: string;
        maxDepth?: number;
        includeTests?: boolean;
        includeIndirectDependencies?: boolean;
      }>();
      const repository = resolveRepo(body.repository);
      requireIndex(repository);
      let nodeId = body.nodeId;
      if (!nodeId) {
        if (!body.symbol) throw new GraphError("INVALID_INPUT", "nodeId or symbol is required");
        const matches = store.graph.searchSymbols(repository, body.symbol);
        const exact = matches.filter(
          (m) => m.name === body.symbol || m.qualifiedName === body.symbol,
        );
        const pick = exact.length > 0 ? exact : matches.length === 1 ? matches : [];
        if (pick.length === 0) {
          throw new GraphError(
            "INVALID_INPUT",
            matches.length > 1
              ? `Ambiguous symbol: ${body.symbol}`
              : `No symbol matches: ${body.symbol}`,
          );
        }
        nodeId = pick[0]!.id;
      }
      const opts: Parameters<typeof store.graph.analyzeImpact>[2] = {};
      if (body.maxDepth !== undefined) opts.maxDepth = body.maxDepth;
      if (body.includeTests !== undefined) opts.includeTests = body.includeTests;
      if (body.includeIndirectDependencies !== undefined)
        opts.includeIndirect = body.includeIndirectDependencies;
      return c.json(store.graph.analyzeImpact(repository, nodeId, opts));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/cycles", (c) => {
    try {
      const repository = resolveRepo(c.req.query("repository"));
      requireIndex(repository);
      return c.json(store.graph.findCycles(repository));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/tests/related", (c) => {
    try {
      const repository = resolveRepo(c.req.query("repository"));
      requireIndex(repository);
      const nodeId = c.req.query("nodeId");
      const symbol = c.req.query("symbol");
      if (!nodeId && !symbol) throw new GraphError("INVALID_INPUT", "nodeId or symbol is required");
      let target = nodeId;
      if (!target) {
        const matches = store.graph.searchSymbols(repository, symbol!);
        const exact = matches.filter((m) => m.name === symbol || m.qualifiedName === symbol);
        const pick = exact.length > 0 ? exact : matches.length === 1 ? matches : [];
        if (pick.length === 0)
          throw new GraphError("INVALID_INPUT", `No symbol matches: ${symbol}`);
        target = pick[0]!.id;
      }
      return c.json({ tests: store.graph.findRelatedTests(repository, target) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/index-status", (c) => {
    try {
      const repository = resolveRepo(c.req.query("repository"));
      const meta = requireIndex(repository);
      return c.json({
        lastRevision: meta.lastRevision,
        indexedAt: meta.indexedAt,
        durationMs: meta.indexingDurationMs,
        fileCount: meta.fileCount,
        nodeCount: meta.nodeCount,
        edgeCount: meta.edgeCount,
        diagnostics: meta.diagnostics,
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
