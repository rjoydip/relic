import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon, FileCodeIcon, PanelRightCloseIcon } from "lucide-react";
import { api, type EvidenceStep, type GraphEdgeDto, type GraphNodeDto } from "./api";
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
  onOpenCode: (code: CodeTarget) => void;
}

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
  onOpenCode,
}: InspectorProps) {
  const [steps, setSteps] = useState<EvidenceStep[]>([]);
  const [tests, setTests] = useState<GraphNodeDto[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const incoming = steps.filter((s) => s.node.id !== node.id);
  const split = {
    incoming: incoming.filter((s) => isIncoming(s, node.id)),
    outgoing: incoming.filter((s) => !isIncoming(s, node.id)),
  };

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
          </div>
        </div>
        <div className="inspector-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            disabled={!canGoBack}
            title="Previous node"
            aria-label="Previous node"
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onForward}
            disabled={!canGoForward}
            title="Next node"
            aria-label="Next node"
          >
            <ChevronRightIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCollapse}
            title="Hide details"
            aria-label="Hide details"
          >
            <PanelRightCloseIcon />
          </Button>
        </div>
      </div>
      <dl className="facts">
        {node.filePath && (
          <>
            <dt>Source</dt>
            <dd className="mono source-row">
              <span className="source-path" title={node.filePath}>
                {node.filePath}
                {node.startLine ? `:${node.startLine}` : ""}
                {node.endLine && node.endLine !== node.startLine ? `–${node.endLine}` : ""}
              </span>
              {/* explicit affordance: opening the file viewer is opt-in */}
              {!offline && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="code-open"
                  title="Open file content"
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
              )}
            </dd>
          </>
        )}
      </dl>

      {error && <p className="error">{error}</p>}

      {split.incoming.length > 0 && (
        <section>
          <h3>Incoming ({split.incoming.length})</h3>
          <EdgeList
            steps={split.incoming}
            offline={offline}
            onSelect={onSelect}
            onOpenCode={onOpenCode}
          />
        </section>
      )}

      {split.outgoing.length > 0 && (
        <section>
          <h3>Outgoing ({split.outgoing.length})</h3>
          <EdgeList
            steps={split.outgoing}
            offline={offline}
            onSelect={onSelect}
            onOpenCode={onOpenCode}
          />
        </section>
      )}

      <section>
        <h3>Related tests ({tests.length})</h3>
        {tests.length === 0 ? (
          <p className="muted">No indexed tests reference this symbol.</p>
        ) : (
          <ul className="edges">
            {tests.map((t) => (
              <li key={t.id}>
                <button className="link" onClick={() => onSelect(t.id)}>
                  {t.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function isIncoming(step: EvidenceStep, nodeId: string): boolean {
  return step.edge.targetId === nodeId;
}

/** One relationship per card: target node, edge type, confidence, evidence. */
function EdgeList({
  steps,
  offline,
  onSelect,
  onOpenCode,
}: {
  steps: EvidenceStep[];
  offline: boolean;
  onSelect: (id: string) => void;
  onOpenCode: (code: CodeTarget) => void;
}) {
  return (
    <ul className="edge-list">
      {steps.map(({ edge, node }) => {
        const file = edge.evidence.file;
        const line = edge.evidence.line ?? null;
        return (
          <li key={`${edge.id}-${node.id}`} className="edge-item">
            <button
              className="edge-target"
              onClick={() => onSelect(node.id)}
              title={node.qualifiedName ?? node.name}
            >
              <span className="edge-name">{node.name}</span>
              <span className={`pill t-${node.type}`}>
                {typeof node.metadata?.kind === "string"
                  ? node.metadata.kind
                  : node.type.replace(/_/g, " ")}
              </span>
            </button>
            <div className="edge-meta">
              <span className="edge-kind">{edge.type.replace(/_/g, " ")}</span>
              <span className="edge-conf" title="Confidence">
                {Math.round(edge.confidence * 100)}%
              </span>
              {file &&
                (offline ? (
                  <span className="edge-file mono" title={file}>
                    {file.split(/[\\/]/).pop()}
                    {line ? `:${line}` : ""}
                  </span>
                ) : (
                  <button
                    className="edge-file mono"
                    title={`Open ${file}${line ? `:${line}` : ""}`}
                    onClick={() => onOpenCode({ path: file, startLine: line, endLine: line })}
                  >
                    {file.split(/[\\/]/).pop()}
                    {line ? `:${line}` : ""}
                  </button>
                ))}
              {edge.evidence.note && (
                <span className="edge-note" title={edge.evidence.note}>
                  {edge.evidence.note}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
