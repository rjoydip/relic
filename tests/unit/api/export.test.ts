import { describe, expect, it } from "bun:test";
import type { GraphEdge, GraphNode } from "@relic/graph-core";
import { toDot, toMermaid } from "../../../apps/api/src/export";

const node = (id: string, name: string): GraphNode => ({
  id,
  repositoryId: "r",
  type: "symbol",
  name,
  qualifiedName: name,
  filePath: `src/${name}.ts`,
  startLine: 1,
  endLine: 2,
  metadata: {},
  updatedAt: "",
});

const edge: GraphEdge = {
  id: "e1",
  repositoryId: "r",
  sourceId: "a",
  targetId: "b",
  type: "CALLS",
  confidence: 1,
  evidence: { source: "static" },
};

const nodes = [node("a", "caller"), node("b", 'weird"name')];

describe("graph export", () => {
  it("renders a Mermaid flowchart", () => {
    const mermaid = toMermaid(nodes, [edge]);
    expect(mermaid).toContain("flowchart LR");
    expect(mermaid).toContain('n0["caller (symbol)"]');
    expect(mermaid).toContain("n0 -->|CALLS| n1");
    expect(mermaid).toContain("&quot;name");
  });

  it("renders Graphviz DOT", () => {
    const dot = toDot(nodes, [edge]);
    expect(dot).toContain("digraph relic {");
    expect(dot).toContain('n0 [label="caller (symbol)"];');
    expect(dot).toContain('n0 -> n1 [label="CALLS"];');
    expect(dot).toContain('weird\\"name');
  });
});
