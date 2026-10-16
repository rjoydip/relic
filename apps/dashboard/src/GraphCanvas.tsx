import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphEdgeDto, GraphNodeDto } from "./api";
import { COLOR, layoutGraph } from "./layout";

type FlowData = { label: string; nodeType: string };

export interface GraphCanvasProps {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  affectedIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function GraphCanvas({ nodes, edges, affectedIds, selectedId, onSelect }: GraphCanvasProps) {
  const position = layoutGraph(nodes, edges);
  const visible = new Set(nodes.map((n) => n.id));

  // Direct neighbours of the selection — everything else dims so the local
  // dependency picture stays readable at any graph size.
  const focus = new Set<string>();
  if (selectedId) {
    focus.add(selectedId);
    for (const e of edges) {
      if (e.sourceId === selectedId) focus.add(e.targetId);
      else if (e.targetId === selectedId) focus.add(e.sourceId);
    }
  }

  const flowNodes: Node<FlowData>[] = nodes.map((n) => {
    const selected = n.id === selectedId;
    const affected = affectedIds.has(n.id);
    const dimmed = selected
      ? false
      : affectedIds.size > 0
        ? !affected
        : selectedId !== null && !focus.has(n.id);
    return {
      id: n.id,
      position: position.get(n.id) ?? { x: 0, y: 0 },
      data: { label: `${n.name}${n.startLine ? `:${n.startLine}` : ""}`, nodeType: n.type },
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
        opacity: dimmed ? 0.25 : 1,
      },
    };
  });

  const flowEdges: Edge[] = edges
    .filter((e) => visible.has(e.sourceId) && visible.has(e.targetId))
    .map((e) => {
      const impact = affectedIds.has(e.sourceId) && affectedIds.has(e.targetId);
      const hot =
        impact || (selectedId !== null && (e.sourceId === selectedId || e.targetId === selectedId));
      const color = impact ? "#ff8a3d" : hot ? "#5e8bff" : "#3c4a61";
      return {
        id: e.id,
        source: e.sourceId,
        target: e.targetId,
        type: "smoothstep",
        // edge labels only on highlighted edges — a large graph stays readable
        ...(hot ? { label: e.type } : {}),
        labelStyle: { fill: "#93a1b5", fontSize: 10 },
        labelBgStyle: { fill: "#0d1117" },
        style: {
          stroke: color,
          strokeWidth: hot ? 2 : 1,
          strokeOpacity: hot
            ? 0.95
            : affectedIds.size > 0 || selectedId
              ? 0.16
              : e.confidence < 1
                ? 0.6
                : 0.9,
        },
        animated: impact,
        markerEnd: { type: MarkerType.ArrowClosed, color },
      };
    });

  const presentTypes = new Set(nodes.map((n) => n.type));

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      fitView
      minZoom={0.15}
      colorMode="dark"
      nodesDraggable={false}
      onNodeClick={(_, node) => onSelect(node.id)}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} color="#1e2733" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        bgColor="#0d1117"
        maskColor="rgba(8,10,14,0.72)"
        nodeStrokeWidth={0}
        nodeColor={(n) => COLOR[(n.data as FlowData).nodeType] ?? "#5d6b7f"}
      />
      <div className="graph-legend" aria-hidden="true">
        {Object.keys(COLOR)
          .filter((t) => presentTypes.has(t))
          .map((t) => (
            <span key={t}>
              <i style={{ background: COLOR[t] }} />
              {t.replace(/_/g, " ")}
            </span>
          ))}
      </div>
    </ReactFlow>
  );
}
