import {
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  getNodesBounds,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  BoxIcon,
  BracesIcon,
  CodeIcon,
  DatabaseIcon,
  FileCode2Icon,
  FileCogIcon,
  FileIcon,
  FileImageIcon,
  FileJsonIcon,
  FileLockIcon,
  FileTextIcon,
  FileTypeIcon,
  FlaskConicalIcon,
  GitForkIcon,
  MonitorIcon,
  PackageIcon,
  RocketIcon,
  RouteIcon,
  ServerIcon,
  TerminalIcon,
  VariableIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { GraphEdgeDto, GraphNodeDto } from "./api";
import {
  COL_WIDTH,
  COLOR,
  LANE_LABEL,
  NODE_H,
  NODE_W,
  laneColumns,
  laneOf,
  layoutGraph,
  type LaneKey,
} from "./layout";

type FlowData = {
  label: string;
  nodeType: string;
  file: string | null;
  kind: string | null;
};

// Edge types collapse into four readable tones — twelve distinct colours is
// noise, four is a legend. Concrete hex because SVG marker fills can't use css vars.
type Tone = "structure" | "flow" | "data" | "tests";

const TONE_OF: Record<string, Tone> = {
  CONTAINS: "structure",
  DECLARES: "structure",
  IMPORTS: "structure",
  DEPENDS_ON: "structure",
  CALLS: "flow",
  EXPOSES: "flow",
  USES_OPERATION: "flow",
  READS: "data",
  WRITES: "data",
  PUBLISHES: "data",
  CONSUMES: "data",
  TESTS: "tests",
};

// turbo-flow palette: violet edges, magenta for data, blue for tests
const TONE_HEX: Record<Tone, Record<"dark" | "light", string>> = {
  structure: { dark: "#5a4668", light: "#7d6b8a" },
  flow: { dark: "#7a4a9b", light: "#6a3f86" },
  data: { dark: "#c73f92", light: "#a03370" },
  tests: { dark: "#467ce1", light: "#2f5fb0" },
};

const TONE_LABEL: Record<Tone, string> = {
  structure: "Structure",
  flow: "Calls",
  data: "Data",
  tests: "Tests",
};

const toneOf = (type: string): Tone => TONE_OF[type] ?? "structure";

export interface GraphCanvasProps {
  theme?: "dark" | "light";
  /** bumped only when navigation comes from outside the canvas */
  focusToken?: number;
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  selectedId: string | null;
  onSelect: (id: string, fromGraph?: boolean) => void;
}

// turbo-flow card glyphs: type icons, with per-extension file icons and
// class/method/function/variable glyphs for symbols
const TYPE_ICONS: Record<string, LucideIcon> = {
  repository: GitForkIcon,
  file: FileIcon,
  route: RouteIcon,
  api_operation: WorkflowIcon,
  frontend_operation: MonitorIcon,
  database_table: DatabaseIcon,
  queue: PackageIcon,
  test: FlaskConicalIcon,
  service: ServerIcon,
  deployment: RocketIcon,
  symbol: BracesIcon,
};

const KIND_ICONS: Record<string, LucideIcon> = {
  class: BoxIcon,
  method: BracesIcon,
  function: BracesIcon,
  variable: VariableIcon,
};

const FILE_ICONS: Record<string, LucideIcon> = {
  ts: FileCode2Icon,
  tsx: FileCode2Icon,
  mts: FileCode2Icon,
  cts: FileCode2Icon,
  js: FileCode2Icon,
  jsx: FileCode2Icon,
  mjs: FileCode2Icon,
  cjs: FileCode2Icon,
  json: FileJsonIcon,
  md: FileTextIcon,
  mdx: FileTextIcon,
  txt: FileTextIcon,
  css: FileTypeIcon,
  scss: FileTypeIcon,
  less: FileTypeIcon,
  html: CodeIcon,
  htm: CodeIcon,
  vue: CodeIcon,
  svelte: CodeIcon,
  yml: FileCogIcon,
  yaml: FileCogIcon,
  toml: FileCogIcon,
  env: FileCogIcon,
  sh: TerminalIcon,
  bash: TerminalIcon,
  zsh: TerminalIcon,
  svg: FileImageIcon,
  png: FileImageIcon,
  jpg: FileImageIcon,
  jpeg: FileImageIcon,
  gif: FileImageIcon,
  webp: FileImageIcon,
  lock: FileLockIcon,
};

function iconFor(nodeType: string, file: string | null, kind: string | null): LucideIcon {
  if (nodeType === "symbol" && kind) return KIND_ICONS[kind] ?? BracesIcon;
  if (nodeType === "file") {
    const ext = (file ?? "").split(".").pop()?.toLowerCase() ?? "";
    return FILE_ICONS[ext] ?? FileIcon;
  }
  return TYPE_ICONS[nodeType] ?? FileIcon;
}

function FlowNodeCard({ data }: NodeProps<Node<FlowData>>) {
  const Icon = iconFor(data.nodeType, data.file, data.kind);
  return (
    <>
      {/* custom node types render no default handles — without these the
          edges have nothing to attach to and never draw */}
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <span className="fn-chip">
        <Icon aria-hidden="true" />
      </span>
      <span className="fn-body">
        <span className="fn-name" title={data.file ?? data.label}>
          {data.label}
        </span>
        <span className="fn-type">{data.kind ?? data.nodeType.replace(/_/g, " ")}</span>
      </span>
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </>
  );
}

const NODE_TYPES = { flow: FlowNodeCard };

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowView {...props} />
    </ReactFlowProvider>
  );
}

function FlowView({
  theme = "dark",
  focusToken = 0,
  nodes,
  edges,
  selectedId,
  onSelect,
}: GraphCanvasProps) {
  const { setCenter, getViewport, setViewport } = useReactFlow();
  const position = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Labelled pipeline lanes behind the cards: one per occupied type column,
  // spanning that column's vertical extent. Rendered in flow coordinates so
  // they pan and zoom with the graph.
  const columns = useMemo(() => laneColumns(nodes), [nodes]);

  const lanes = useMemo(() => {
    const extent = new Map<LaneKey, { column: number; min: number; max: number; count: number }>();
    for (const n of nodes) {
      const pos = position.get(n.id);
      if (!pos) continue;
      const key = laneOf(n);
      const column = columns.get(key) ?? 0;
      const box = extent.get(key);
      if (box) {
        box.min = Math.min(box.min, pos.y);
        box.max = Math.max(box.max, pos.y);
        box.count++;
      } else extent.set(key, { column, min: pos.y, max: pos.y, count: 1 });
    }
    return [...extent.entries()]
      .sort((a, b) => a[1].column - b[1].column)
      .map(([key, box]) => ({
        column: box.column,
        label: LANE_LABEL[key],
        count: box.count,
        x: box.column * COL_WIDTH - 14,
        y: box.min - 46,
        width: NODE_W + 28,
        height: box.max - box.min + NODE_H + 72,
      }));
  }, [nodes, position, columns]);

  // Point the view at selections made outside the canvas (tree, search,
  // inspector). Clicking a card itself must never pan the graph under the
  // cursor, so a plain selection change does not move the viewport.
  const lastFocus = useRef(focusToken);
  useEffect(() => {
    if (focusToken === lastFocus.current) return;
    lastFocus.current = focusToken;
    if (!selectedId) return;
    const pos = position.get(selectedId);
    if (!pos) return;
    setCenter(pos.x + NODE_W / 2, pos.y + NODE_H / 2, {
      zoom: getViewport().zoom,
      duration: 650,
    });
  }, [focusToken, selectedId, position, setCenter, getViewport]);

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
      // explicit dimensions keep bounds stable before nodes are measured
      width: NODE_W,
      height: NODE_H,
      position: position.get(n.id) ?? { x: 0, y: 0 },
      data: {
        label: `${n.name}${n.startLine ? `:${n.startLine}` : ""}`,
        nodeType: n.type,
        file: n.filePath,
        kind: typeof n.metadata?.kind === "string" ? n.metadata.kind : null,
      },
      className: `flow-node${selected ? " sel" : ""}${dimmed ? " dim" : ""}${
        !selected && !dimmed && focus.has(n.id) ? " near" : ""
      }`,
      // visuals live in style.css (theme + hover states); only the per-type
      // accent varies per node, as a CSS custom property
      style: { "--node-accent": COLOR[n.type] ?? "#5d6b7f" } as CSSProperties,
    };
  });

  const flowEdges: Edge[] = edges
    .filter((e) => visible.has(e.sourceId) && visible.has(e.targetId))
    .map((e) => {
      const hot = selectedId !== null && (e.sourceId === selectedId || e.targetId === selectedId);
      const dimming = selectedId !== null && !hot;
      const tone = toneOf(e.type);
      const color = hot ? "var(--accent)" : TONE_HEX[tone][theme];
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
          stroke: color,
          strokeWidth: hot ? 2 : 1.3,
          strokeOpacity: dimming
            ? theme === "light"
              ? 0.16
              : 0.1
            : hot
              ? 1
              : tone === "structure"
                ? 0.55
                : 0.85,
        },
        // animation is a focus signal, not wallpaper
        animated: hot,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      };
    });

  // Counts per tone for the legend; only tones present in the current view.
  const toneCounts = new Map<Tone, number>();
  for (const e of edges) {
    if (!visible.has(e.sourceId) || !visible.has(e.targetId)) continue;
    const tone = toneOf(e.type);
    toneCounts.set(tone, (toneCounts.get(tone) ?? 0) + 1);
  }
  const legend = (Object.keys(TONE_LABEL) as Tone[])
    .map((tone) => ({ tone, count: toneCounts.get(tone) ?? 0 }))
    .filter((t) => t.count > 0);

  // Initial view: a readable zoom anchored at the top of the graph. Fitting
  // the whole graph to the screen shrinks big repos into unreadable dots —
  // clamp the zoom instead and let the user scroll down to explore.
  // Set in onInit, NOT in an effect: ReactFlow applies its own default
  // viewport asynchronously while initialising, which overwrites any
  // setViewport call made earlier. (key={repoId} remounts GraphCanvas, so
  // this re-runs per repo.)
  const applyInitialViewport = () => {
    const el = containerRef.current;
    if (!el || flowNodes.length === 0) return;
    const bounds = getNodesBounds(flowNodes);
    const pad = 40;
    // fit the graph's width when it fits, stay within [0.55, 0.9] otherwise
    const zoom = Math.min(0.9, Math.max(0.55, (el.clientWidth - pad * 2) / bounds.width));
    setViewport({
      zoom,
      x: (el.clientWidth - bounds.width * zoom) / 2 - bounds.x * zoom,
      // extra headroom keeps the lane headers visible above the first row
      y: pad + 18 - bounds.y * zoom,
    });
  };

  return (
    <ReactFlow
      ref={containerRef}
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={NODE_TYPES}
      minZoom={0.15}
      colorMode={theme}
      nodesDraggable={false}
      panOnScroll
      onInit={applyInitialViewport}
      onNodeClick={(_, node) => onSelect(node.id, true)}
      proOptions={{ hideAttribution: true }}
    >
      <ViewportPortal>
        {lanes.map((lane) => (
          <div
            key={lane.column}
            className="flow-lane"
            style={{
              transform: `translate(${lane.x}px, ${lane.y}px)`,
              width: lane.width,
              height: lane.height,
            }}
          >
            <span className="flow-lane-label">
              {lane.label} <b>{lane.count}</b>
            </span>
          </div>
        ))}
      </ViewportPortal>

      {legend.length > 0 && (
        <Panel position="top-center" className="graph-legend">
          <span className="graph-legend-title">Relationships</span>
          <div className="graph-legend-items">
            {legend.map(({ tone, count }) => (
              <span
                key={tone}
                className="graph-legend-item"
                style={{ "--tone": TONE_HEX[tone][theme] } as CSSProperties}
              >
                <i aria-hidden="true" />
                {TONE_LABEL[tone]}
                <b>{count}</b>
              </span>
            ))}
          </div>
        </Panel>
      )}

      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}
