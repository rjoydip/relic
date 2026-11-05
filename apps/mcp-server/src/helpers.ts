import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { GraphNode, NodeType } from "@relic/graph-core";
import { GraphError } from "@relic/graph-core";
import { repositoryIdFor } from "@relic/analyzer-typescript";
import { changedRanges, symbolsForRanges, type ChangedRange } from "@relic/indexer";

export { changedRanges, symbolsForRanges };
export type { ChangedRange };

/** Hard cap: the agent reads a window, never the whole file. */
export const MAX_EXCERPT_LINES = 80;

export interface SourceExcerpt {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: Array<{ line: number; text: string }>;
  truncated: boolean;
}

/** Bounded, line-numbered source window for a node, read from the indexed repo. */
export function sourceExcerpt(rootPath: string, node: GraphNode): SourceExcerpt | null {
  if (!node.filePath || node.startLine == null) return null;
  const root = resolve(rootPath);
  const abs = resolve(join(root, node.filePath));
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const all = text.split(/\r?\n/);
  const start = Math.max(1, node.startLine);
  const declaredEnd = Math.min(node.endLine ?? start, all.length);
  const end = Math.min(declaredEnd, start + MAX_EXCERPT_LINES - 1);
  const lines: SourceExcerpt["lines"] = [];
  for (let line = start; line <= end; line++) {
    lines.push({ line, text: all[line - 1] ?? "" });
  }
  return {
    filePath: node.filePath,
    startLine: start,
    endLine: end,
    totalLines: Math.max(0, declaredEnd - start + 1),
    lines,
    truncated: end < declaredEnd,
  };
}

export function coerceRepositoryId(
  repository: string | undefined,
  indexed: (id: string) => boolean,
): string {
  const candidate = repository?.trim();
  if (!candidate) throw new GraphError("INVALID_INPUT", "repository is required");
  if (indexed(candidate)) return candidate;
  return repositoryIdFor(candidate);
}

export function coerceNodeType(type: string | undefined): NodeType | undefined {
  if (!type) return undefined;
  const allowed: NodeType[] = [
    "repository",
    "file",
    "symbol",
    "route",
    "api_operation",
    "database_table",
    "database_query",
    "queue",
    "test",
    "frontend_operation",
    "service",
    "deployment",
  ];
  if (!allowed.includes(type as NodeType))
    throw new GraphError("INVALID_INPUT", `Unknown node type: ${type}`);
  return type as NodeType;
}
