import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Diagnostic, GraphEdge, GraphNode } from "@skein/graph-core";

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

export interface RepositoryContext {
  /** Stable repository ID derived from the canonical root path. */
  id: string;
  rootPath: string;
  name: string;
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
  };
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
