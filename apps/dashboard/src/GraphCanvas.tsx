import {
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, type CSSProperties } from "react";
import type { GraphEdgeDto, GraphNodeDto } from "./api";
import { COLOR, layoutGraph } from "./layout";

type FlowData = { label: string; nodeType: string };

const NODE_W = 210;
const NODE_H = 44;

// concrete hex for edge/marker colours (SVG attributes can't resolve var())
const EDGE_HEX: Record<"dark" | "light", string> = { dark: "#3d3d3d", light: "#9aa8bd" };

export interface GraphCanvasProps {
  theme?: "dark" | "light";
  /** resolved accent hex — markers track it live with the color picker */
  accent?: string;
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

// turbo-flow card glyphs — one 16px stroke glyph per node type, tinted by
// the type colour inside the accent chip
const TYPE_GLYPH: Record<string, string> = {
  symbol:
    "M6.2 4.2c-1.2 0-1 1.5-1 2.3 0 .7-.4 1-.8 1.7-.4.6-.7 1-.7 1.7 0 .8-.2 2.3 1 2.3M9.8 4.2c1.2 0 1 1.5 1 2.3 0 .7.4 1 .8 1.7.4.6.7 1 .7 1.7 0 .8.2 2.3-1 2.3",
  route: "M3 8h8 M8 5l3 3-3 3",
  api_operation:
    "M5 3v3 M11 3v3 M3.5 6h9v2.5A3.5 3.5 0 0 1 9 12H7a3.5 3.5 0 0 1-3.5-3.5z M8 12v1.6",
  frontend_operation: "M2.5 4h11v8h-11z M2.5 6.5h11 M4.8 8.2l1.2 1.2-1.2 1.2 M8 10.6h3",
  database_table:
    "M3 4.2c0-1 2.2-1.6 5-1.6s5 .6 5 1.6-2.2 1.6-5 1.6-5-.6-5-1.6z M3 4.2v7.6c0 1 2.2 1.6 5 1.6s5-.6 5-1.6V4.2 M3 8c0 1 2.2 1.6 5 1.6s5-.6 5-1.6",
  test: "M6.5 2.6v4L3.6 12a1.2 1.2 0 0 0 1 1.8h6.8a1.2 1.2 0 0 0 1-1.8L9.5 6.6v-4 M5.6 2.6h4.8 M5.2 9.2h5.6",
  file: "M4 2.2h5l3 3v8.6H4z M9 2.2v3h3",
  queue: "M2.5 5h11 M2.5 8h11 M2.5 11h7",
};

function FlowNodeCard({ data }: NodeProps<Node<FlowData>>) {
  return (
    <>
      {/* custom node types render no default handles — without these the
          edges have nothing to attach to and never draw */}
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <span className="fn-chip">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d={TYPE_GLYPH[data.nodeType] ?? TYPE_GLYPH.file}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="fn-body">
        <span className="fn-name">{data.label}</span>
        <span className="fn-type">{data.nodeType.replace(/_/g, " ")}</span>
      </span>
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </>
  );
}

function GroupLabelCard({ data }: NodeProps<Node<FlowData>>) {
  return <span>{data.label}</span>;
}

const NODE_TYPES = { flow: FlowNodeCard, groupLabel: GroupLabelCard };

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowView {...props} />
    </ReactFlowProvider>
  );
}

function FlowView({
  theme = "dark",
  accent = "#5e8bff",
  nodes,
  edges,
  selectedId,
  onSelect,
}: GraphCanvasProps) {
  const { setCenter, getViewport } = useReactFlow();
  const position = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);

  // Point the view at the selection — sidebar clicks (impact list, search)
  // must land on the node, not just populate the inspector.
  useEffect(() => {
    if (!selectedId) return;
    const pos = position.get(selectedId);
    if (!pos) return;
    setCenter(pos.x + NODE_W / 2, pos.y + NODE_H / 2, {
      zoom: getViewport().zoom,
      duration: 400,
    });
  }, [selectedId, position, setCenter, getViewport]);

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

  const visible = new Set(nodes.map((n) => n.id));

  const flowNodes: Node<FlowData>[] = nodes.map((n) => {
    const selected = n.id === selectedId;
    const dimmed = !selected && selectedId !== null && !focus.has(n.id);
    return {
      id: n.id,
      type: "flow",
      position: position.get(n.id) ?? { x: 0, y: 0 },
      data: { label: `${n.name}${n.startLine ? `:${n.startLine}` : ""}`, nodeType: n.type },
      className: `flow-node${selected ? " sel" : ""}${dimmed ? " dim" : ""}`,
      // visuals live in style.css (theme + hover states); only the per-type
      // accent varies per node, as a CSS custom property
      style: { "--node-accent": COLOR[n.type] ?? "#5d6b7f" } as CSSProperties,
    };
  });

  // one heading per type column, aligned to the layout — the graph reads as
  // organised groups instead of a floating sheet of cards
  const presentTypes = new Set(nodes.map((n) => n.type));
  const groupLabels: Node<FlowData>[] = [...presentTypes].map((t) => {
    const first = nodes.find((n) => n.type === t);
    const x = first ? (position.get(first.id)?.x ?? 0) : 0;
    return {
      id: `group:${t}`,
      type: "groupLabel",
      position: { x, y: -52 },
      data: { label: t.replace(/_/g, " "), nodeType: t },
      className: "group-label",
      draggable: false,
      selectable: false,
      deletable: false,
      focusable: false,
    };
  });

  const flowEdges: Edge[] = edges
    .filter((e) => visible.has(e.sourceId) && visible.has(e.targetId))
    .map((e) => {
      const hot = selectedId !== null && (e.sourceId === selectedId || e.targetId === selectedId);
      const dimming = selectedId !== null && !hot;
      return {
        id: e.id,
        source: e.sourceId,
        target: e.targetId,
        type: "smoothstep",
        // edge labels only on highlighted edges — a large graph stays readable
        ...(hot ? { label: e.type } : {}),
        labelStyle: { fill: "var(--dim)", fontSize: 10 },
        labelBgStyle: { fill: "var(--panel)" },
        style: {
          stroke: hot ? "var(--accent)" : "var(--edge)",
          strokeWidth: hot ? 2 : 1.4,
          strokeOpacity: hot ? 0.95 : dimming ? 0.16 : e.confidence < 1 ? 0.7 : 1,
        },
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: hot ? accent : EDGE_HEX[theme],
        },
      };
    });

  return (
    <ReactFlow
      nodes={[...flowNodes, ...groupLabels]}
      edges={flowEdges}
      nodeTypes={NODE_TYPES}
      fitView
      minZoom={0.15}
      colorMode={theme}
      nodesDraggable={false}
      panOnScroll
      onNodeClick={(_, node) => onSelect(node.id)}
      proOptions={{ hideAttribution: true }}
    >
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}
