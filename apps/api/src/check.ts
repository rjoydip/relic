import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EdgeType, GraphEdge, GraphNode } from "@relic/graph-core";

export interface BoundaryRule {
  /** Glob for the importing file, e.g. "src/ui/**". */
  from: string;
  /** Glob for the imported file, e.g. "src/database/**". */
  to: string;
  message?: string;
  /** Defaults to IMPORTS. */
  edgeTypes?: EdgeType[];
}

export interface BoundaryConfig {
  boundaries?: BoundaryRule[];
}

export interface BoundaryViolation {
  rule: BoundaryRule;
  edge: GraphEdge;
  fromFile: string;
  toFile: string;
}

const DEFAULT_EDGE_TYPES: EdgeType[] = ["IMPORTS"];
const CONFIG_FILES = [".relicrc.json", "relic.config.json"];

export function loadBoundaryConfig(
  rootPath: string,
  explicitPath?: string,
): { rules: BoundaryRule[]; source: string } | null {
  const candidates = explicitPath
    ? [explicitPath]
    : CONFIG_FILES.map((name) => join(rootPath, name));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BoundaryConfig;
    const rules = (parsed.boundaries ?? []).filter(
      (rule) =>
        typeof rule?.from === "string" &&
        typeof rule?.to === "string" &&
        rule.from.length > 0 &&
        rule.to.length > 0,
    );
    return { rules, source: path };
  }
  return null;
}

/** Glob matcher for repo-relative paths: `*`, `**`, `?`, with `**` crossing `/`. */
export function globMatch(pattern: string, filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const trimmed = pattern.replace(/\\/g, "/").replace(/^\.?\//, "");
  let source = "";
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!;
    if (char === "*") {
      if (trimmed[i + 1] === "*") {
        i++;
        if (trimmed[i + 1] === "/") {
          source += "(?:.*/)?";
          i++;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$+.|()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`).test(normalized);
}

/** Evaluate boundary rules against dependency edges with resolved file paths. */
export function evaluateBoundaries(
  edges: GraphEdge[],
  nodeById: (id: string) => GraphNode | null,
  rules: BoundaryRule[],
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const rule of rules) {
    const types = new Set<EdgeType>(rule.edgeTypes ?? DEFAULT_EDGE_TYPES);
    for (const edge of edges) {
      if (!types.has(edge.type)) continue;
      const fromFile = nodeById(edge.sourceId)?.filePath;
      const toFile = nodeById(edge.targetId)?.filePath;
      if (!fromFile || !toFile) continue;
      if (!globMatch(rule.from, fromFile) || !globMatch(rule.to, toFile)) continue;
      violations.push({ rule, edge, fromFile, toFile });
    }
  }
  return violations;
}
