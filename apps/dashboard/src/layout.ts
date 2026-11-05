import type { GraphEdgeDto, GraphNodeDto } from "./api";

/** One lane per analyzer kind — symbols are not lumped into a single column. */
export type LaneKey =
  | "files"
  | "entrypoints"
  | "class"
  | "method"
  | "function"
  | "variable"
  | "data";

const LANE_ORDER: LaneKey[] = [
  "files",
  "entrypoints",
  "class",
  "method",
  "function",
  "variable",
  "data",
];

export const LANE_LABEL: Record<LaneKey, string> = {
  files: "Files",
  entrypoints: "Entrypoints",
  class: "Classes",
  method: "Methods",
  function: "Functions",
  variable: "Variables",
  data: "Data & tests",
};

/** Which pipeline lane a node belongs to. */
export function laneOf(n: GraphNodeDto): LaneKey {
  if (n.type === "symbol") {
    const kind = typeof n.metadata?.kind === "string" ? n.metadata.kind : "";
    if (kind === "class" || kind === "method" || kind === "function" || kind === "variable")
      return kind;
    // unknown symbol kind: the generic code lane
    return "function";
  }
  if (n.type === "file" || n.type === "repository") return "files";
  if (
    n.type === "route" ||
    n.type === "api_operation" ||
    n.type === "frontend_operation" ||
    n.type === "queue"
  )
    return "entrypoints";
  if (
    n.type === "database_table" ||
    n.type === "test" ||
    n.type === "service" ||
    n.type === "deployment"
  )
    return "data";
  return "function";
}

/** Compact column numbers for the lanes that actually contain nodes. */
export function laneColumns(nodes: GraphNodeDto[]): Map<LaneKey, number> {
  const present = new Set(nodes.map(laneOf));
  const columns = new Map<LaneKey, number>();
  let column = 0;
  for (const key of LANE_ORDER) {
    if (present.has(key)) columns.set(key, column++);
  }
  return columns;
}

export const COLOR: Record<string, string> = {
  repository: "#98a6b5",
  file: "#79a8e0",
  route: "#5cbe8a",
  api_operation: "#57c4b6",
  frontend_operation: "#d8a94f",
  queue: "#a58ad8",
  symbol: "#7d9cf8",
  database_table: "#e09055",
  test: "#83ca8a",
  service: "#98a6b5",
  deployment: "#98a6b5",
};

export const NODE_W = 210;
export const NODE_H = 44;
export const COL_WIDTH = 320;
const ROW_HEIGHT = 84;

/**
 * Layered layout: nodes sit in type columns; inside a column they are ordered
 * by the barycenter of their already-placed neighbours (normalised by that
 * column's height) so edges run mostly straight instead of crossing. Nodes
 * with no placed neighbours sort last, name order as tiebreak — deterministic
 * for a given node/edge set regardless of input order.
 */
export function layoutGraph(
  nodes: GraphNodeDto[],
  edges: GraphEdgeDto[],
): Map<string, { x: number; y: number }> {
  const columns = laneColumns(nodes);
  const colOf = new Map<string, number>();
  const groups = new Map<number, GraphNodeDto[]>();
  for (const n of nodes) {
    const col = columns.get(laneOf(n)) ?? 0;
    colOf.set(n.id, col);
    const group = groups.get(col);
    if (group) group.push(n);
    else groups.set(col, [n]);
  }

  const neighbors = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = neighbors.get(a);
    if (set) set.add(b);
    else neighbors.set(a, new Set([b]));
  };
  for (const e of edges) {
    link(e.sourceId, e.targetId);
    link(e.targetId, e.sourceId);
  }

  const row = new Map<string, number>();
  const colSize = new Map<number, number>();
  const position = new Map<string, { x: number; y: number }>();

  for (const [col, group] of [...groups].sort((a, b) => a[0] - b[0])) {
    const scored = group.map((n) => {
      let sum = 0;
      let count = 0;
      for (const m of neighbors.get(n.id) ?? []) {
        const r = row.get(m);
        if (r === undefined) continue;
        sum += r / (colSize.get(colOf.get(m) ?? 0) ?? 1);
        count++;
      }
      return { n, score: count ? sum / count : Number.MAX_SAFE_INTEGER };
    });
    scored.sort((a, b) => a.score - b.score || a.n.name.localeCompare(b.n.name));
    scored.forEach((s, i) => {
      row.set(s.n.id, i);
      position.set(s.n.id, { x: col * COL_WIDTH, y: i * ROW_HEIGHT });
    });
    colSize.set(col, scored.length);
  }

  return position;
}
