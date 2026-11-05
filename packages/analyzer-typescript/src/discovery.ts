import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Diagnostic, GraphEdge, GraphNode } from "@relic/graph-core";
import * as ts from "typescript";

export const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "out",
  ".data",
]);

/** Import-resolution settings read once per index run. */
export interface ImportConfig {
  /** Repo-relative directory that `paths` targets resolve from. */
  baseUrl: string | null;
  /** Raw tsconfig `paths` map (targets stay relative to `baseUrl`). */
  paths: Record<string, string[]>;
  /** Workspace package name -> repo-relative package directory. */
  workspaces: Map<string, string>;
}

export interface RepositoryContext {
  /** Stable repository ID derived from the canonical root path. */
  id: string;
  rootPath: string;
  name: string;
  importConfig: ImportConfig;
}

export interface FileAnalysis {
  /** Repository-relative path with forward slashes. */
  filePath: string;
  absolutePath: string;
  contentHash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

export function repositoryIdFor(rootPath: string): string {
  return `repo_${createHash("sha1").update(resolve(rootPath)).digest("hex").slice(0, 12)}`;
}

export function makeRepositoryContext(root: string): RepositoryContext {
  const rootPath = resolve(root);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw new Error(`Not a directory: ${rootPath}`);
  }
  return {
    id: repositoryIdFor(rootPath),
    rootPath,
    name: rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath,
    importConfig: loadImportConfig(rootPath),
  };
}

/** Read root tsconfig paths/baseUrl (following `extends`) and workspace package names. */
function loadImportConfig(rootPath: string): ImportConfig {
  let baseUrl: string | null = null;
  let paths: Record<string, string[]> = {};
  const configPath = ["tsconfig.json", "tsconfig.base.json", "jsconfig.json"]
    .map((name) => join(rootPath, name))
    .find((path) => existsSync(path));
  if (configPath) {
    try {
      const parsed = ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: () => {},
        },
      );
      if (parsed) {
        if (parsed.options.baseUrl) baseUrl = toRepoDir(rootPath, parsed.options.baseUrl);
        if (parsed.options.paths) paths = parsed.options.paths;
      }
    } catch {
      // A malformed tsconfig must not stop indexing; imports fall back to external.
    }
  }
  return { baseUrl, paths, workspaces: loadWorkspaces(rootPath) };
}

function toRepoDir(rootPath: string, absolutePath: string): string {
  const rel = relative(rootPath, resolve(absolutePath)).split(sep).join("/");
  return rel === "" ? "." : rel;
}

function loadWorkspaces(rootPath: string): Map<string, string> {
  const map = new Map<string, string>();
  const manifest = join(rootPath, "package.json");
  if (!existsSync(manifest)) return map;
  let pkg: { workspaces?: unknown };
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown };
  } catch {
    return map;
  }
  const patterns = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : isRecord(pkg.workspaces) && Array.isArray(pkg.workspaces.packages)
      ? (pkg.workspaces.packages as unknown[])
      : [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    for (const dir of expandWorkspacePattern(rootPath, pattern)) {
      try {
        const child = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: unknown;
        };
        if (typeof child.name === "string") map.set(child.name, toRepoDir(rootPath, dir));
      } catch {
        // workspace without a readable manifest is ignored
      }
    }
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Supports the `dir/*` shapes used by npm/bun workspaces; `**` is not needed in practice. */
function expandWorkspacePattern(rootPath: string, pattern: string): string[] {
  let dirs = [rootPath];
  for (const part of pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "*") {
      dirs = dirs.flatMap((dir) => {
        try {
          return readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
            .map((e) => join(dir, e.name));
        } catch {
          return [];
        }
      });
    } else {
      dirs = dirs
        .map((dir) => join(dir, part))
        .filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
    }
  }
  return dirs.filter((dir) => {
    const rel = relative(rootPath, dir);
    return rel !== "" && !rel.startsWith("..") && !rel.includes(":");
  });
}

/** Reject any path that resolves outside the repository root. */
export function toRepoRelative(rootPath: string, absolutePath: string): string {
  const rel = relative(rootPath, resolve(absolutePath));
  if (rel.startsWith("..") || resolve(join(rootPath, rel)) !== resolve(absolutePath)) {
    throw new Error(`Path escapes repository boundary: ${absolutePath}`);
  }
  return rel.split(sep).join("/");
}

export function walkRepository(rootPath: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(full);
      } else if (SUPPORTED_EXTENSIONS.has(extOf(entry.name))) {
        out.push(toRepoRelative(rootPath, full));
      }
    }
  };
  visit(rootPath);
  return out.sort();
}

export function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

export function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

export function readFileHash(absolutePath: string): string {
  return sha1(readFileSync(absolutePath, "utf8"));
}

export function isTestFile(filePath: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath) || /(^|\/)(tests?|__tests__)\//.test(filePath)
  );
}
