import type { GraphEdgeDto, GraphNodeDto } from "./api";

export const COLUMN: Record<string, number> = {
  repository: 0,
  file: 0,
  route: 1,
  api_operation: 1,
  frontend_operation: 1,
  queue: 1,
  symbol: 2,
  database_table: 3,
  test: 3,
  service: 3,
  deployment: 3,
};

export const COLOR: Record<string, string> = {
  repository: "#8b98aa",
  file: "#6e8bb5",
  route: "#4caf7d",
  api_operation: "#38b2a3",
  frontend_operation: "#d9a441",
  queue: "#a97bd9",
  symbol: "#5b8cff",
  database_table: "#e06c75",
  test: "#7cc47f",
  service: "#8b98aa",
  deployment: "#8b98aa",
};

const COL_WIDTH = 320;
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
  const colOf = new Map<string, number>();
  const groups = new Map<number, GraphNodeDto[]>();
  for (const n of nodes) {
    const col = COLUMN[n.type] ?? 2;
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
        sum += r / (colSize.get(colOf.get(m) ?? 2) ?? 1);
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
