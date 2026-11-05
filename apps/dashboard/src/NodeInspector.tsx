import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileCodeIcon,
  FolderTreeIcon,
  PanelRightCloseIcon,
} from "lucide-react";
import {
  api,
  type CycleReportDto,
  type EvidenceStep,
  type GraphEdgeDto,
  type GraphNodeDto,
  type ImpactResultDto,
} from "./api";
import type { CodeTarget } from "./CodeModal";
import { COLOR } from "./layout";

interface InspectorProps {
  repoId: string;
  node: GraphNodeDto | null;
  /** client-side snapshot mode — relationships come from the snapshot, not the API */
  offline: boolean;
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onSelect: (id: string) => void;
  onCollapse: () => void;
  onHidePanel: () => void;
  onOpenCode: (code: CodeTarget) => void;
  cycles: CycleReportDto | null;
  onHighlightCycle: (ids: string[]) => void;
  highlightedCycle: string[];
}

type TabKey = "impact" | "relationships" | "tests" | "cycles";

/** Same dependency edge set as GraphService coupling metrics. */
const COUPLING_TYPES = new Set([
  "CALLS",
  "IMPORTS",
  "USES_OPERATION",
  "READS",
  "WRITES",
  "EXPOSES",
  "TESTS",
  "DEPENDS_ON",
  "PUBLISHES",
  "CONSUMES",
]);

export function NodeInspector({
  repoId,
  node,
  offline,
  nodes,
  edges,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onSelect,
  onCollapse,
  onHidePanel,
  onOpenCode,
  cycles,
  onHighlightCycle,
  highlightedCycle,
}: InspectorProps) {
  const [steps, setSteps] = useState<EvidenceStep[]>([]);
  const [tests, setTests] = useState<GraphNodeDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactResultDto | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [impactBusy, setImpactBusy] = useState(false);
  const [includeTests, setIncludeTests] = useState(true);
  const [includeIndirect, setIncludeIndirect] = useState(false);
  const [tab, setTab] = useState<TabKey>("impact");
  const impactNode = useRef<string | null>(null);

  useEffect(() => {
    setTab("impact");
  }, [node?.id]);

  useEffect(() => {
    if (!node) {
      setSteps([]);
      setTests([]);
      return;
    }
    if (offline) {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const local: EvidenceStep[] = [];
      for (const edge of edges) {
        if (edge.sourceId !== node.id && edge.targetId !== node.id) continue;
        const other = byId.get(edge.sourceId === node.id ? edge.targetId : edge.sourceId);
        if (other) local.push({ edge, node: other });
      }
      setSteps(local);
      setTests(local.map((s) => s.node).filter((n) => n.type === "test"));
      return;
    }
    let cancelled = false;
    setError(null);
    Promise.all([
      api.neighborhood(node.id),
      api
        .relatedTests(repoId, node.qualifiedName ?? node.name)
        .catch(() => ({ tests: [] as GraphNodeDto[] })),
    ])
      .then(([hood, testList]) => {
        if (cancelled) return;
        setSteps(hood.steps);
        setTests(testList.tests);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [node?.id, repoId, offline, nodes, edges]);

  // Impact is an API call; static snapshot mode has no server to traverse the
  // graph, so the section stays hidden there rather than duplicating the
  // traversal rules in the client.
  useEffect(() => {
    if (!node || offline) {
      setImpact(null);
      setImpactError(null);
      return;
    }
    let cancelled = false;
    // Keep the table visible while toggles refetch; clear only for a new node.
    if (impactNode.current !== node.id) {
      setImpact(null);
      impactNode.current = node.id;
    }
    setImpactError(null);
    setImpactBusy(true);
    api
      .impact(repoId, node.id, { includeTests, includeIndirect })
      .then((result) => {
        if (!cancelled) setImpact(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setImpactError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setImpactBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [node?.id, repoId, offline, includeTests, includeIndirect]);

  const coupling = useMemo(() => {
    if (!node) return { fanIn: 0, fanOut: 0, instability: 0 };
    const fanIn = new Set(
      edges
        .filter(
          (edge) =>
            COUPLING_TYPES.has(edge.type) && edge.targetId === node.id && edge.sourceId !== node.id,
        )
        .map((edge) => edge.sourceId),
    ).size;
    const fanOut = new Set(
      edges
        .filter(
          (edge) =>
            COUPLING_TYPES.has(edge.type) && edge.sourceId === node.id && edge.targetId !== node.id,
        )
        .map((edge) => edge.targetId),
    ).size;
    return {
      fanIn,
      fanOut,
      instability: fanIn + fanOut === 0 ? 0 : fanOut / (fanIn + fanOut),
    };
  }, [edges, node?.id]);
  const currentImpact = node && impactNode.current === node.id ? impact : null;
  const riskDrivers = useMemo(
    () => (currentImpact ? driversOf(currentImpact) : []),
    [currentImpact],
  );

  if (!node) {
    return (
      <div className="inspector">
        <h2>Details</h2>
        <p className="muted">
          Select a node to inspect its source evidence, relationships, and tests.
        </p>
      </div>
    );
  }

  const { fanIn, fanOut, instability } = coupling;

  const incoming = steps.filter((s) => s.node.id !== node.id);
  const split = {
    incoming: incoming.filter((s) => isIncoming(s, node.id)),
    outgoing: incoming.filter((s) => !isIncoming(s, node.id)),
  };
  const owners = Array.isArray(node.metadata?.owners)
    ? node.metadata.owners.filter((owner): owner is string => typeof owner === "string")
    : [];
  const nodeCycles =
    cycles?.cycles.filter((cycle) => cycle.nodes.some((member) => member.id === node.id)) ?? [];
  const risk = currentImpact && !impactBusy ? currentImpact.summary.risk : null;
  const relationshipCount = split.incoming.length + split.outgoing.length;

  const tabs: Array<{ key: TabKey; label: string; count: number }> = [
    { key: "impact", label: "Impact", count: currentImpact?.affected.length ?? 0 },
    { key: "relationships", label: "Relationships", count: relationshipCount },
    { key: "tests", label: "Tests", count: tests.length },
    ...(nodeCycles.length > 0
      ? [{ key: "cycles" as const, label: "Cycles", count: nodeCycles.length }]
      : []),
  ];
  const activeTab = tabs.some((entry) => entry.key === tab) ? tab : "impact";

  return (
    <div
      className="inspector"
      style={{ "--node-accent": COLOR[node.type] ?? "#5d6b7f" } as CSSProperties}
    >
      <div className="inspector-head">
        <div className="inspector-title">
          <h2>{node.qualifiedName ?? node.name}</h2>
          <div className="inspector-meta">
            <span className={`pill t-${node.type}`}>
              {typeof node.metadata?.kind === "string"
                ? node.metadata.kind
                : node.type.replace(/_/g, " ")}
            </span>
            <span className="inspector-stat">
              <b>{split.incoming.length}</b> in
            </span>
            <span className="inspector-stat">
              <b>{split.outgoing.length}</b> out
            </span>
            <span className="inspector-stat">
              <b>{tests.length}</b> tests
            </span>
            {nodeCycles.length > 0 && (
              <span className="inspector-stat warn">
                <b>{nodeCycles.length}</b> cycle{nodeCycles.length === 1 ? "" : "s"}
              </span>
            )}
            {risk && (
              <span className="inspector-stat risk">
                risk <b>{risk.score}</b>
              </span>
            )}
          </div>
        </div>
        <div className="inspector-actions">
          <Hint label="Previous node">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onBack}
              disabled={!canGoBack}
              aria-label="Previous node"
            >
              <ChevronLeftIcon />
            </Button>
          </Hint>
          <Hint label="Next node">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onForward}
              disabled={!canGoForward}
              aria-label="Next node"
            >
              <ChevronRightIcon />
            </Button>
          </Hint>
          <Hint label="Show files">
            <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Show files">
              <FolderTreeIcon />
            </Button>
          </Hint>
          <Hint label="Hide panel">
            <Button variant="ghost" size="icon-sm" onClick={onHidePanel} aria-label="Hide panel">
              <PanelRightCloseIcon />
            </Button>
          </Hint>
        </div>
      </div>

      <dl className="facts">
        {node.filePath && (
          <>
            <dt>Source</dt>
            <dd className="mono source-row">
              <Hint label={node.filePath}>
                <span className="source-path">
                  {node.filePath}
                  {node.startLine ? `:${node.startLine}` : ""}
                  {node.endLine && node.endLine !== node.startLine ? `–${node.endLine}` : ""}
                </span>
              </Hint>
              {!offline && (
                <Hint label="Open file content">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="code-open"
                    aria-label="Open file content"
                    onClick={() =>
                      onOpenCode({
                        path: node.filePath!,
                        startLine: node.startLine,
                        endLine: node.endLine,
                      })
                    }
                  >
                    <FileCodeIcon />
                  </Button>
                </Hint>
              )}
            </dd>
          </>
        )}
        <dt>Coupling</dt>
        <dd className="coupling-row">
          <span>
            <b>{fanIn}</b> in · <b>{fanOut}</b> out
          </span>
          <Hint label="Instability = fan-out / (fan-in + fan-out). 0 is stable, 1 is unstable.">
            <span className="muted" tabIndex={0}>
              instability {instability.toFixed(2)}
            </span>
          </Hint>
        </dd>
        <dt>Owners</dt>
        <dd className={owners.length > 0 ? "mono owners-row" : "muted"}>
          {owners.length > 0 ? owners.join(", ") : "No CODEOWNERS match"}
        </dd>
      </dl>

      {error && <p className="error">{error}</p>}

      <div className="inspector-tabs" role="tablist" aria-label="Details sections">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={activeTab === entry.key}
            className="inspector-tab"
            onClick={() => setTab(entry.key)}
          >
            {entry.label} <span className="count">({entry.count})</span>
          </button>
        ))}
      </div>

      <div className="inspector-tabpanel" role="tabpanel">
        {activeTab === "impact" && (
          <>
            {!offline ? (
              <>
                <div className="impact-controls">
                  <Hint label="Include TESTS edges in the impact result">
                    <label>
                      <input
                        type="checkbox"
                        checked={includeTests}
                        onChange={(e) => setIncludeTests(e.target.checked)}
                      />
                      tests
                    </label>
                  </Hint>
                  <Hint label="Also list this node's own direct dependencies (downstream)">
                    <label>
                      <input
                        type="checkbox"
                        checked={includeIndirect}
                        onChange={(e) => setIncludeIndirect(e.target.checked)}
                      />
                      indirect
                    </label>
                  </Hint>
                  {currentImpact && !impactBusy && (
                    <span className="impact-summary">
                      {currentImpact.summary.affectedSymbols} symbols ·{" "}
                      {currentImpact.summary.affectedTests} tests · max depth{" "}
                      {currentImpact.summary.maxDepth}
                    </span>
                  )}
                </div>

                {risk && (
                  <div className="risk-card">
                    <div className="risk-head">
                      <Hint
                        side="bottom"
                        label={
                          <span className="tooltip-list">
                            {risk.factors.map((factor) => (
                              <span key={factor.key}>
                                {factor.label} <b>+{factor.points}</b>
                              </span>
                            ))}
                          </span>
                        }
                      >
                        <span className="risk-score" tabIndex={0}>
                          risk <b>{risk.score}</b>/100
                        </span>
                      </Hint>
                      <span className="risk-bar" aria-hidden="true">
                        <i style={{ width: `${risk.score}%` }} />
                      </span>
                    </div>
                    {riskDrivers.length > 0 && (
                      <div className="risk-drivers">
                        <span className="risk-drivers-title">Risk-related files</span>
                        {riskDrivers.map((driver) => (
                          <div className="risk-driver" key={driver.key}>
                            <span className="risk-driver-label">{driver.label}</span>
                            <div className="risk-files">
                              {driver.files.map((file) => (
                                <Hint
                                  key={file.path}
                                  label={`Open ${file.path}${file.line ? `:${file.line}` : ""}`}
                                >
                                  <button
                                    className="edge-file mono"
                                    onClick={() =>
                                      onOpenCode({
                                        path: file.path,
                                        startLine: file.line,
                                        endLine: file.line,
                                      })
                                    }
                                  >
                                    {file.path.split(/[\\/]/).pop()}
                                    {file.line ? `:${file.line}` : ""}
                                  </button>
                                </Hint>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {!includeIndirect && (
                  <p className="muted inspector-hint">
                    Downstream dependencies are hidden — tick “indirect” to include them.
                  </p>
                )}

                {impactBusy ? (
                  <p className="muted">Analyzing…</p>
                ) : impactError ? (
                  <p className="error">{impactError}</p>
                ) : currentImpact ? (
                  <ImpactTable
                    rows={currentImpact.affected}
                    onSelect={onSelect}
                    onOpenCode={onOpenCode}
                  />
                ) : null}
              </>
            ) : (
              <p className="muted">Impact analysis needs the local API.</p>
            )}
          </>
        )}

        {activeTab === "relationships" && (
          <RelationshipsTable
            steps={[...split.incoming, ...split.outgoing]}
            nodeId={node.id}
            offline={offline}
            onSelect={onSelect}
            onOpenCode={onOpenCode}
          />
        )}

        {activeTab === "tests" && (
          <TestsTable tests={tests} offline={offline} onSelect={onSelect} onOpenCode={onOpenCode} />
        )}

        {activeTab === "cycles" && (
          <CyclesTable
            cycles={nodeCycles}
            onSelect={onSelect}
            onHighlightCycle={onHighlightCycle}
            highlightedCycle={highlightedCycle}
          />
        )}
      </div>
    </div>
  );
}

function ImpactTable({
  rows,
  onSelect,
  onOpenCode,
}: {
  rows: ImpactResultDto["affected"];
  onSelect: (id: string) => void;
  onOpenCode: (code: CodeTarget) => void;
}) {
  return (
    <table className="inspector-table">
      <thead>
        <tr>
          <th>Node</th>
          <th>Direction</th>
          <th>Relationship</th>
          <th>Depth</th>
          <th>Conf.</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={6} className="muted">
              Nothing depends on this node.
            </td>
          </tr>
        ) : (
          rows.slice(0, 100).map((row) => {
            const file = row.evidence.file;
            const line = row.evidence.line ?? null;
            return (
              <tr
                key={`${row.direction}-${row.node.id}-${row.relationship}`}
                className="impact-item"
              >
                <td>
                  <div className="node-cell">
                    <Hint label={row.node.qualifiedName ?? row.node.name}>
                      <button className="link" onClick={() => onSelect(row.node.id)}>
                        {row.node.name}
                      </button>
                    </Hint>
                    <span className={`pill t-${row.node.type}`}>
                      {typeof row.node.metadata?.kind === "string"
                        ? row.node.metadata.kind
                        : row.node.type.replace(/_/g, " ")}
                    </span>
                  </div>
                </td>
                <td>
                  <span className={`dir-pill dir-${row.direction}`}>{row.direction}</span>
                </td>
                <td className="mono cell-muted">{row.relationship.replace(/_/g, " ")}</td>
                <td className="cell-nowrap">{row.depth || "—"}</td>
                <td className="cell-nowrap cell-conf">{Math.round(row.confidence * 100)}%</td>
                <td>{file && <FileLink file={file} line={line} onOpenCode={onOpenCode} />}</td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

function RelationshipsTable({
  steps,
  nodeId,
  offline,
  onSelect,
  onOpenCode,
}: {
  steps: EvidenceStep[];
  nodeId: string;
  offline: boolean;
  onSelect: (id: string) => void;
  onOpenCode: (code: CodeTarget) => void;
}) {
  const rows = [...steps].sort(
    (a, b) => Number(isIncoming(b, nodeId)) - Number(isIncoming(a, nodeId)),
  );
  return (
    <table className="inspector-table">
      <thead>
        <tr>
          <th>Node</th>
          <th>Direction</th>
          <th>Type</th>
          <th>Conf.</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={5} className="muted">
              No indexed relationships.
            </td>
          </tr>
        ) : (
          rows.map(({ edge, node }) => {
            const file = edge.evidence.file;
            const line = edge.evidence.line ?? null;
            return (
              <tr key={`${edge.id}-${node.id}`} className="relationship-item">
                <td>
                  <div className="node-cell">
                    <Hint label={node.qualifiedName ?? node.name}>
                      <button className="link" onClick={() => onSelect(node.id)}>
                        {node.name}
                      </button>
                    </Hint>
                    <span className={`pill t-${node.type}`}>
                      {typeof node.metadata?.kind === "string"
                        ? node.metadata.kind
                        : node.type.replace(/_/g, " ")}
                    </span>
                  </div>
                </td>
                <td>
                  <span
                    className={`dir-pill dir-${isIncoming({ edge, node }, nodeId) ? "in" : "out"}`}
                  >
                    {isIncoming({ edge, node }, nodeId) ? "incoming" : "outgoing"}
                  </span>
                </td>
                <td className="mono cell-muted">{edge.type.replace(/_/g, " ")}</td>
                <td className="cell-nowrap">{Math.round(edge.confidence * 100)}%</td>
                <td>
                  {file &&
                    (offline ? (
                      <Hint label={file}>
                        <span className="edge-file mono">{shortPath(file, line)}</span>
                      </Hint>
                    ) : (
                      <FileLink file={file} line={line} onOpenCode={onOpenCode} />
                    ))}
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

function TestsTable({
  tests,
  offline,
  onSelect,
  onOpenCode,
}: {
  tests: GraphNodeDto[];
  offline: boolean;
  onSelect: (id: string) => void;
  onOpenCode: (code: CodeTarget) => void;
}) {
  return (
    <table className="inspector-table">
      <thead>
        <tr>
          <th>Test</th>
          <th>File</th>
          <th>Line</th>
        </tr>
      </thead>
      <tbody>
        {tests.length === 0 ? (
          <tr>
            <td colSpan={3} className="muted">
              No indexed tests reference this symbol.
            </td>
          </tr>
        ) : (
          tests.map((test) => (
            <tr key={test.id} className="test-item">
              <td>
                <Hint label={test.qualifiedName ?? test.name}>
                  <button className="link" onClick={() => onSelect(test.id)}>
                    {test.name}
                  </button>
                </Hint>
              </td>
              <td>
                {test.filePath &&
                  (offline ? (
                    <span className="edge-file mono">{test.filePath.split(/[\\/]/).pop()}</span>
                  ) : (
                    <FileLink file={test.filePath} line={test.startLine} onOpenCode={onOpenCode} />
                  ))}
              </td>
              <td className="cell-nowrap">{test.startLine ?? "—"}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function CyclesTable({
  cycles,
  onSelect,
  onHighlightCycle,
  highlightedCycle,
}: {
  cycles: CycleReportDto["cycles"];
  onSelect: (id: string) => void;
  onHighlightCycle: (ids: string[]) => void;
  highlightedCycle: string[];
}) {
  return (
    <>
      <table className="inspector-table">
        <thead>
          <tr>
            <th>Cycle</th>
            <th>Nodes</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {cycles.map((cycle, index) => (
            <tr key={cycle.id} className="cycle-item">
              <td className="cell-nowrap">
                #{index + 1} <span className="muted">({cycle.size})</span>
              </td>
              <td>
                <div className="cycle-members">
                  {cycle.nodes.map((member) => (
                    <Hint key={member.id} label={member.qualifiedName ?? member.name}>
                      <button className="link" onClick={() => onSelect(member.id)}>
                        {member.qualifiedName ?? member.name}
                      </button>
                    </Hint>
                  ))}
                </div>
              </td>
              <td className="cell-nowrap">
                <button
                  className="link"
                  onClick={() => onHighlightCycle(cycle.nodes.map((member) => member.id))}
                >
                  Highlight
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {highlightedCycle.length > 0 && (
        <button className="link" onClick={() => onHighlightCycle([])}>
          Clear highlight
        </button>
      )}
    </>
  );
}

function FileLink({
  file,
  line,
  onOpenCode,
}: {
  file: string;
  line: number | null;
  onOpenCode: (code: CodeTarget) => void;
}) {
  return (
    <Hint label={`Open ${file}${line ? `:${line}` : ""}`}>
      <button
        className="edge-file mono"
        onClick={() => onOpenCode({ path: file, startLine: line, endLine: line })}
      >
        {shortPath(file, line)}
      </button>
    </Hint>
  );
}

function shortPath(file: string, line: number | null): string {
  return `${file.split(/[\\/]/).pop()}${line ? `:${line}` : ""}`;
}

interface RiskDriver {
  key: string;
  label: string;
  files: Array<{ path: string; line: number | null }>;
}

/** Files behind the risk score: route exposure, inferred edges, untested symbols, depth. */
function driversOf(impact: ImpactResultDto): RiskDriver[] {
  const filesFor = (rows: ImpactResultDto["affected"]) => {
    const files = new Map<string, { path: string; line: number | null }>();
    for (const row of rows) {
      const path = row.evidence.file ?? row.node.filePath;
      if (!path) continue;
      if (!files.has(path)) {
        files.set(path, { path, line: row.evidence.line ?? row.node.startLine ?? null });
      }
    }
    return [...files.values()].slice(0, 5);
  };
  const rows = impact.affected;
  return [
    {
      key: "routeExposure",
      label: "Route exposure",
      files: filesFor(
        rows.filter((r) => r.node.type === "route" || r.node.type === "api_operation"),
      ),
    },
    {
      key: "inferred",
      label: "Inferred edges",
      files: filesFor(rows.filter((r) => r.confidence < 1)),
    },
    {
      key: "missingTests",
      label: "No test coverage",
      files:
        impact.summary.affectedTests === 0
          ? filesFor(rows.filter((r) => r.node.type === "symbol"))
          : [],
    },
    {
      key: "depth",
      label: "Deep impact",
      files: filesFor(rows.filter((r) => r.depth >= 3)),
    },
  ].filter((driver) => driver.files.length > 0);
}

function isIncoming(step: EvidenceStep, nodeId: string): boolean {
  return step.edge.targetId === nodeId;
}
