import {
  Background,
  BackgroundVariant,
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
const EDGE_HEX: Record<"dark" | "light", string> = { dark: "#4b5d80", light: "#9aa8bd" };
const ORANGE_HEX: Record<"dark" | "light", string> = { dark: "#ff8a3d", light: "#dd6610" };

export interface GraphCanvasProps {
  theme?: "dark" | "light";
  /** resolved accent hex — markers track it live with the color picker */
  accent?: string;
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  affectedIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function FlowNodeCard({ data }: NodeProps<Node<FlowData>>) {
  return (
    <>
      {/* custom node types render no default handles — without these the
          edges have nothing to attach to and never draw */}
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <span className="fn-name">{data.label}</span>
      <span className="fn-type">{data.nodeType.replace(/_/g, " ")}</span>
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
  affectedIds,
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
    const affected = affectedIds.has(n.id);
    const dimmed = selected
      ? false
      : affectedIds.size > 0
        ? !affected
        : selectedId !== null && !focus.has(n.id);
    return {
      id: n.id,
      type: "flow",
      position: position.get(n.id) ?? { x: 0, y: 0 },
      data: { label: `${n.name}${n.startLine ? `:${n.startLine}` : ""}`, nodeType: n.type },
      className: `flow-node${selected ? " sel" : ""}${affected ? " aff" : ""}${dimmed ? " dim" : ""}`,
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
      style: { "--node-accent": COLOR[t] ?? "#5d6b7f" } as CSSProperties,
    };
  });

  const flowEdges: Edge[] = edges
    .filter((e) => visible.has(e.sourceId) && visible.has(e.targetId))
    .map((e) => {
      const impact = affectedIds.has(e.sourceId) && affectedIds.has(e.targetId);
      const hot =
        impact || (selectedId !== null && (e.sourceId === selectedId || e.targetId === selectedId));
      const dimming = affectedIds.size > 0 || (selectedId !== null && !hot);
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
          stroke: impact ? "var(--orange)" : hot ? "var(--accent)" : "var(--edge)",
          strokeWidth: hot ? 2 : 1.4,
          strokeOpacity: hot ? 0.95 : dimming ? 0.16 : e.confidence < 1 ? 0.7 : 1,
        },
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: impact ? ORANGE_HEX[theme] : hot ? accent : EDGE_HEX[theme],
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
      <Background variant={BackgroundVariant.Dots} gap={18} color="#1e2733" />
      <Controls showInteractive={false} position="bottom-left" />
      <div className="graph-legend" aria-hidden="true">
        {[...presentTypes]
          .filter((t) => COLOR[t])
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
