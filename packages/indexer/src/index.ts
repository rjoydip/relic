import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Diagnostic, GraphRepository, RepositoryMeta } from "@skein/graph-core";
import { GraphService } from "@skein/graph-core";
import { DatabaseClient, SqliteGraphRepository, type ReplaceGraphInput } from "@skein/database";
import {
  extractFile,
  fileId,
  makeRepositoryContext,
  readFileHash,
  relate,
  walkRepository,
  type ExtractedFile,
  type RefInfo,
  type RefLookup,
} from "@skein/analyzer-typescript";

export interface IndexResult {
  repositoryId: string;
  analyzedFiles: number;
  totalFiles: number;
  deletedFiles: number;
  skippedEdges: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
  revision: string | null;
  diagnostics: Diagnostic[];
}

/** Orchestrates extract → relate → transactional persist, incrementally. */
export class Indexer {
  constructor(private readonly repo: GraphRepository) {}

  index(root: string, options: { revision?: string | null } = {}): IndexResult {
    const started = Date.now();
    const ctx = makeRepositoryContext(root);
    const current = walkRepository(ctx.rootPath);
    const stored = this.repo.listFiles(ctx.id);
    const storedHashes = new Map(stored.map((f) => [f.filePath, f.contentHash]));

    const deletedFiles = stored.filter((f) => !current.includes(f.filePath)).map((f) => f.filePath);
    const changed = current.filter(
      (p) => storedHashes.get(p) !== readFileHash(join(ctx.rootPath, p)),
    );

    // Re-analyze importers of changed/deleted files so import edges re-resolve.
    const importers = new Set<string>();
    const affectedFileIds = [...changed, ...deletedFiles].map((p) => fileId(ctx.id, p));
    if (affectedFileIds.length > 0 && stored.length > 0) {
      for (const edge of this.repo.getEdges({
        targetIds: affectedFileIds,
        edgeTypes: ["IMPORTS"],
        limit: 5000,
      })) {
        const source = this.repo.getNode(edge.sourceId);
        if (source?.filePath && current.includes(source.filePath)) importers.add(source.filePath);
      }
    }
    const deletedSet = new Set(deletedFiles);
    const toAnalyze = [...new Set([...changed, ...importers])].filter((p) => !deletedSet.has(p));

    // Pass A: extract declarations and pending relationships.
    const extracted = new Map<string, ExtractedFile>();
    for (const path of toAnalyze) extracted.set(path, extractFile(ctx, path));

    // Shared ref lookup: fresh results first, database for everything else.
    const freshRefs = new Map<string, RefInfo[]>();
    for (const file of extracted.values()) {
      for (const ref of file.refs) {
        const bucket = freshRefs.get(ref.name);
        if (bucket) bucket.push(ref);
        else freshRefs.set(ref.name, [ref]);
      }
    }
    const lookup: RefLookup = {
      findByName: (name) => {
        const fresh = freshRefs.get(name) ?? [];
        const db = this.repo
          .lookupSymbols(ctx.id, name)
          .filter((r) => r !== null)
          .map((r) => ({
            id: r.id,
            name: r.name,
            qualifiedName: r.qualifiedName ?? r.name,
            filePath: r.filePath ?? "",
          }));
        return [...fresh, ...db.filter((d) => !fresh.some((f) => f.id === d.id))];
      },
    };

    // Pass B: resolve relationships for analyzed files only.
    const files: ReplaceGraphInput["files"] = [];
    const diagnostics: Diagnostic[] = [];
    for (const [path, file] of extracted) {
      const result = relate(ctx, file, lookup);
      files.push({ filePath: path, nodes: file.nodes, edges: result.edges });
      diagnostics.push(...result.diagnostics);
    }

    const revision = options.revision !== undefined ? options.revision : gitRevision(ctx.rootPath);
    const meta: RepositoryMeta = {
      id: ctx.id,
      name: ctx.name,
      rootPath: ctx.rootPath,
      lastRevision: revision,
      indexedAt: new Date().toISOString(),
      indexingDurationMs: Date.now() - started,
      fileCount: current.length,
      nodeCount: 0,
      edgeCount: 0,
      diagnostics: dedupeDiagnostics(diagnostics),
    };

    const { skippedEdges } = this.repo.replaceRepositoryGraph({ meta, files, deletedFiles });
    if (skippedEdges > 0) {
      meta.diagnostics.push({
        kind: "unresolved",
        message: `${skippedEdges} edges skipped: missing endpoints`,
      });
      this.repo.upsertRepository(meta);
    }

    const counts = this.repo.counts(ctx.id);
    return {
      repositoryId: ctx.id,
      analyzedFiles: toAnalyze.length,
      totalFiles: current.length,
      deletedFiles: deletedFiles.length,
      skippedEdges,
      nodeCount: counts.nodes,
      edgeCount: counts.edges,
      durationMs: Date.now() - started,
      revision,
      diagnostics: meta.diagnostics,
    };
  }
}

function gitRevision(rootPath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.kind}|${d.message}|${d.file ?? ""}|${d.line ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface OpenGraph {
  repository: SqliteGraphRepository;
  graph: GraphService;
  indexer: Indexer;
  close(): void;
}

/** One-liner wiring for apps: SQLite store + services + indexer. */
export function openGraph(dbPath: string): OpenGraph {
  const repository = new SqliteGraphRepository(new DatabaseClient(dbPath));
  return {
    repository,
    graph: new GraphService(repository),
    indexer: new Indexer(repository),
    close: () => repository.close(),
  };
}

export { makeRepositoryContext, repositoryIdFor } from "@skein/analyzer-typescript";
export type { GraphRepository, NodeFilter } from "@skein/graph-core";
