import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic, GraphRepository, RepositoryMeta } from "@relic/graph-core";
import { GraphService } from "@relic/graph-core";
import { DatabaseClient, SqliteGraphRepository, type ReplaceGraphInput } from "@relic/database";
import {
  extractManifest,
  fileId,
  loadCodeowners,
  makeRepositoryContext,
  ownersFor,
  readFileHash,
  relate,
  walkManifestFiles,
  walkRepository,
  type ExtractedFile,
  type ManifestGraph,
  type RefInfo,
  type RefLookup,
} from "@relic/analyzer-typescript";
import { extractFile } from "@relic/analyzer-typescript";
import { extractPythonFile } from "@relic/analyzer-python";
import { extractRustFile } from "@relic/analyzer-rust";
import { extractJavaFile } from "@relic/analyzer-java";
import { extractGoFile } from "@relic/analyzer-go";

/** Language dispatch: every analyzer emits the shared ExtractedFile contract. */
function extractSourceFile(
  repo: Parameters<typeof extractFile>[0],
  filePath: string,
): ExtractedFile {
  if (filePath.endsWith(".py")) return extractPythonFile(repo, filePath);
  if (filePath.endsWith(".rs")) return extractRustFile(repo, filePath);
  if (filePath.endsWith(".java")) return extractJavaFile(repo, filePath);
  if (filePath.endsWith(".go")) return extractGoFile(repo, filePath);
  return extractFile(repo, filePath);
}

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
    const external = this.externalPackages(ctx.id);
    // ponytail: a CODEOWNERS edit only reaches files that are re-analyzed; run
    // a full re-index when ownership changes matter.
    const codeowners = loadCodeowners(ctx.rootPath);
    const codeFiles = walkRepository(ctx.rootPath);
    const manifestFiles = walkManifestFiles(ctx.rootPath);
    const manifestSet = new Set(manifestFiles);
    const current = [...new Set([...codeFiles, ...manifestFiles])].sort();
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
    const manifests = new Map<string, ManifestGraph>();
    for (const path of toAnalyze) {
      if (manifestSet.has(path)) manifests.set(path, extractManifest(ctx, path));
      else extracted.set(path, extractSourceFile(ctx, path));
    }
    for (const file of extracted.values()) resolveExternalImports(file.imports, external);

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
    for (const manifest of manifests.values()) {
      files.push({
        filePath: manifest.filePath,
        nodes: manifest.nodes,
        edges: manifest.edges,
      });
    }
    for (const [path, file] of extracted) {
      // CODEOWNERS applies to every node declared in the file; blame is
      // resolved on demand by the owners query rather than at index time.
      const owners = ownersFor(codeowners, path);
      if (owners.length > 0) {
        for (const node of file.nodes) {
          if (node.filePath) node.metadata = { ...node.metadata, owners };
        }
      }
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

  /** Package name -> repository files for every other indexed repository. */
  private externalPackages(currentId: string): Map<string, ExternalPackage> {
    const out = new Map<string, ExternalPackage>();
    for (const meta of this.repo.listRepositories()) {
      if (meta.id === currentId) continue;
      const files = this.repo.listFiles(meta.id).map((file) => file.filePath);
      for (const pkg of packageNames(meta.rootPath)) {
        out.set(pkg.name, { repositoryId: meta.id, dir: pkg.dir, files });
      }
    }
    return out;
  }
}

interface ExternalPackage {
  repositoryId: string;
  /** Repo-relative workspace directory; "" for the repository root. */
  dir: string;
  files: string[];
}

function resolveExternalImports(
  imports: Array<{
    targetFile: string | null;
    specifier?: string;
    targetRepositoryId?: string;
  }>,
  external: Map<string, ExternalPackage>,
): void {
  for (const binding of imports) {
    if (binding.targetFile || !binding.specifier || binding.specifier.startsWith(".")) continue;
    const match = [...external.entries()]
      .filter(([name]) => binding.specifier === name || binding.specifier!.startsWith(`${name}/`))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (!match) continue;
    const [name, pkg] = match;
    const subpath = binding.specifier.slice(name.length + 1);
    const target = entryFile(pkg, subpath);
    if (!target) continue;
    binding.targetFile = target;
    binding.targetRepositoryId = pkg.repositoryId;
  }
}

/** Root package plus simple one-level workspace packages (`packages/*`, `apps/*`). */
function packageNames(rootPath: string): Array<{ name: string; dir: string }> {
  const out: Array<{ name: string; dir: string }> = [];
  const root = readPackage(rootPath);
  if (root.name) out.push({ name: root.name, dir: "" });
  for (const pattern of root.workspaces) {
    const base = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!base.endsWith("/*")) continue;
    const parent = base.slice(0, -2);
    let entries;
    try {
      entries = readdirSync(join(rootPath, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = `${parent}/${entry.name}`;
      const child = readPackage(join(rootPath, dir));
      if (child.name) out.push({ name: child.name, dir });
    }
  }
  return out;
}

function readPackage(dir: string): { name: string | null; workspaces: string[] } {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return { name: null, workspaces: [] };
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: unknown;
      workspaces?: unknown;
    };
    const raw: unknown = pkg.workspaces;
    const workspaces: unknown[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object"
        ? (((raw as { packages?: unknown }).packages as unknown[]) ?? [])
        : [];
    return {
      name: typeof pkg.name === "string" ? pkg.name : null,
      workspaces: workspaces.filter((item): item is string => typeof item === "string"),
    };
  } catch {
    return { name: null, workspaces: [] };
  }
}

function entryFile(pkg: ExternalPackage, subpath: string): string | null {
  const bases = subpath
    ? [subpath, `src/${subpath}`]
    : ["src/index", "index", "src/main", "main", "src/index.py", "index.py"];
  const candidates = bases.flatMap((base) =>
    /\.\w+$/.test(base)
      ? [base]
      : [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}.js`,
          `${base}.jsx`,
          `${base}.py`,
          `${base}/index.ts`,
          `${base}/index.tsx`,
          `${base}/index.js`,
          `${base}/__init__.py`,
        ],
  );
  for (const candidate of candidates) {
    const path = pkg.dir ? `${pkg.dir}/${candidate}` : candidate;
    if (pkg.files.includes(path)) return path;
  }
  return null;
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

export { makeRepositoryContext, repositoryIdFor } from "@relic/analyzer-typescript";
export type { GraphRepository, NodeFilter } from "@relic/graph-core";
export * from "./changes";
export * from "./runtime";
