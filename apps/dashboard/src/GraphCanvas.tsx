import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphEdgeDto, GraphNodeDto } from "./api";

const COLUMN: Record<string, number> = {
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

const COLOR: Record<string, string> = {
  repository: "#444",
  file: "#3b5b7a",
  route: "#2f7d4f",
  api_operation: "#2f7d6a",
  frontend_operation: "#7a5b2f",
  queue: "#5b2f7a",
  symbol: "#31425c",
  database_table: "#7a2f3b",
  test: "#3c6e3c",
  service: "#555",
  deployment: "#555",
};

function stableHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export interface GraphCanvasProps {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  affectedIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function GraphCanvas({ nodes, edges, affectedIds, selectedId, onSelect }: GraphCanvasProps) {
  const columns = new Map<number, number>();
  const flowNodes: Node[] = nodes.map((n) => {
    const col = COLUMN[n.type] ?? 2;
    const row = columns.get(col) ?? 0;
    columns.set(col, row + 1);
    const selected = n.id === selectedId;
    const affected = affectedIds.has(n.id);
    return {
      id: n.id,
      position: {
        x: col * 340 + (stableHash(n.id) % 5) * 24,
        y: row * 84 + (stableHash(n.id + "y") % 4) * 18,
      },
      data: { label: `${n.name}${n.startLine ? `:${n.startLine}` : ""}` },
      style: {
        backgroundColor: COLOR[n.type] ?? "#333",
        color: "#fff",
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        width: 200,
        border: selected ? "2px solid #ffb020" : affected ? "2px solid #ff6a00" : "1px solid #666",
        opacity: selected || affected || affectedIds.size === 0 ? 1 : 0.55,
      },
    };
  });

  const visible = new Set(nodes.map((n) => n.id));
  const flowEdges: Edge[] = edges
    .filter((e) => visible.has(e.sourceId) && visible.has(e.targetId))
    .map((e) => ({
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      label: e.type,
      labelStyle: { fill: "#9db2cf", fontSize: 10 },
      style: {
        stroke: affectedIds.has(e.sourceId) && affectedIds.has(e.targetId) ? "#ff6a00" : "#5c7291",
        strokeOpacity: e.confidence < 1 ? 0.5 : 0.9,
      },
      animated: affectedIds.has(e.sourceId) && affectedIds.has(e.targetId),
      markerEnd: { type: MarkerType.ArrowClosed, color: "#5c7291" },
    }));

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      fitView
      minZoom={0.15}
      onNodeClick={(_, node) => onSelect(node.id)}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#2c3440" gap={18} />
      <Controls />
    </ReactFlow>
  );
}
