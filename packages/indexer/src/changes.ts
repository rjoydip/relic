import { execFileSync } from "node:child_process";
import { GraphError } from "@relic/graph-core";
import type { GraphNode } from "@relic/graph-core";

export interface ChangedRange {
  filePath: string;
  lines: number[];
}

/** Read `git diff --unified=0 <base> <head>` with argument-based execution
 * (never shell interpolation) and map hunks to new-side line ranges. */
export function changedRanges(rootPath: string, base?: string, head?: string): ChangedRange[] {
  const args = ["diff", "--unified=0"];
  if (base) args.push(base);
  if (head) args.push(head);
  let out: string;
  try {
    out = execFileSync("git", args, {
      cwd: rootPath,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    throw new GraphError(
      "INVALID_INPUT",
      `git diff failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
  }
  const ranges: ChangedRange[] = [];
  let current: ChangedRange | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const rel = line.slice(6).trim();
      current = { filePath: rel === "/dev/null" ? "" : rel, lines: [] };
      if (current.filePath) ranges.push(current);
      else current = null;
      continue;
    }
    if (line.startsWith("@@") && current) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const start = Number(match[1]);
        const count = match[2] === undefined ? 1 : Number(match[2]);
        if (count === 0) current.lines.push(Math.max(1, start - 1));
        else for (let i = 0; i < count; i++) current.lines.push(start + i);
      }
    }
  }
  return ranges;
}

/** Symbols whose declared line range intersects the changed lines. */
export function symbolsForRanges(nodes: GraphNode[], ranges: ChangedRange[]): GraphNode[] {
  const targets: GraphNode[] = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    const changed = new Set(range.lines);
    for (const node of nodes) {
      if (seen.has(node.id)) continue;
      if (node.type !== "symbol" || !node.filePath || node.filePath !== range.filePath) continue;
      const start = node.startLine;
      const end = node.endLine;
      if (start == null || end == null) continue;
      for (let line = start; line <= end; line++) {
        if (changed.has(line)) {
          seen.add(node.id);
          targets.push(node);
          break;
        }
      }
    }
  }
  return targets;
}
