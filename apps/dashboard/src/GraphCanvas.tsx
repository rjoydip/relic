import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
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
        backgroundColor: selected ? "#182031" : "#121824",
        color: "#e8eef7",
        borderRadius: 10,
        padding: "8px 12px",
        fontSize: 12.5,
        fontWeight: 500,
        width: 210,
        border: `1px solid ${selected ? "#3d5c9e" : affected ? "#8a4a1f" : "#232d3d"}`,
        borderLeft: `3px solid ${COLOR[n.type] ?? "#5d6b7f"}`,
        boxShadow: selected
          ? "0 0 0 3px rgba(94,139,255,0.25)"
          : affected
            ? "0 0 0 3px rgba(255,138,61,0.2)"
            : "0 1px 2px rgba(0,0,0,0.35)",
        opacity: selected || affected || affectedIds.size === 0 ? 1 : 0.5,
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
      labelStyle: { fill: "#93a1b5", fontSize: 10 },
      labelBgStyle: { fill: "#0d1117" },
      style: {
        stroke: affectedIds.has(e.sourceId) && affectedIds.has(e.targetId) ? "#ff8a3d" : "#3c4a61",
        strokeOpacity: e.confidence < 1 ? 0.6 : 0.95,
      },
      animated: affectedIds.has(e.sourceId) && affectedIds.has(e.targetId),
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: affectedIds.has(e.sourceId) && affectedIds.has(e.targetId) ? "#ff8a3d" : "#3c4a61",
      },
    }));

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      fitView
      minZoom={0.15}
      colorMode="dark"
      onNodeClick={(_, node) => onSelect(node.id)}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} color="#1e2733" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
