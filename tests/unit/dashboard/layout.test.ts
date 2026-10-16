import { describe, expect, test } from "bun:test";
import type { GraphEdgeDto, GraphNodeDto } from "../../../apps/dashboard/src/api";
import { layoutGraph } from "../../../apps/dashboard/src/layout";

function node(id: string, name: string, type = "symbol"): GraphNodeDto {
  return { id, name, type, qualifiedName: null, filePath: "f.ts", startLine: null, endLine: null };
}

function edge(sourceId: string, targetId: string): GraphEdgeDto {
  return {
    id: `${sourceId}->${targetId}`,
    sourceId,
    targetId,
    type: "CALLS",
    confidence: 1,
    evidence: { source: "test" },
  };
}

describe("layoutGraph", () => {
  test("gives every node a position and unique rows per column", () => {
    const pos = layoutGraph(
      [node("a", "Alpha", "file"), node("b", "Beta", "file"), node("c", "Gamma", "file")],
      [],
    );
    expect(pos.size).toBe(3);
    expect(new Set([...pos.values()].map((p) => p.y))).toEqual(new Set([0, 84, 168]));
    for (const p of pos.values()) expect(p.x).toBe(0);
  });

  test("orders a column by the barycenter of its earlier neighbours", () => {
    // Column 0 (file): A, B, C → rows 0, 1, 2 by name.
    // Column 2 (symbol): M links to C(2) and B(1) → score 1.5; N links to
    // A(0) → score 0; O has no edges → last.
    // B also links to T (col 3, unplaced → skipped when scoring B).
    const pos = layoutGraph(
      [
        node("a", "A", "file"),
        node("b", "B", "file"),
        node("c", "C", "file"),
        node("m", "M", "symbol"),
        node("n", "N", "symbol"),
        node("o", "O", "symbol"),
        node("t", "T", "test"),
      ],
      [edge("m", "c"), edge("m", "b"), edge("n", "a"), edge("b", "t")],
    );
    expect(pos.get("n")?.y).toBe(0);
    expect(pos.get("m")?.y).toBe(84);
    expect(pos.get("o")?.y).toBe(168);
    expect(pos.get("a")?.y).toBeLessThan(pos.get("c")?.y as number);
    expect(pos.get("t")?.x).toBe(960);
  });

  test("unknown types fall into the default column", () => {
    const pos = layoutGraph([node("x", "X", "mystery")], []);
    expect(pos.get("x")?.x).toBe(640);
  });

  test("is deterministic regardless of input order", () => {
    const nodes = [
      node("a", "A", "file"),
      node("b", "B", "symbol"),
      node("d", "D", "symbol"),
      node("e", "E", "symbol"),
      node("c", "C", "test"),
    ];
    const edges = [edge("b", "a"), edge("c", "b")];
    const first = layoutGraph(nodes, edges);
    const second = layoutGraph([...nodes].reverse(), [...edges].reverse());
    expect(second).toEqual(first);
  });
});
