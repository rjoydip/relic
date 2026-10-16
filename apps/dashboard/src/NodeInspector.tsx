import { useEffect, useState } from "react";
import { api, type EvidenceStep, type GraphNodeDto } from "./api";

interface InspectorProps {
  repoId: string;
  node: GraphNodeDto | null;
  onSelect: (id: string) => void;
  onAnalyzeImpact: (symbol: string) => void;
}

export function NodeInspector({ repoId, node, onSelect, onAnalyzeImpact }: InspectorProps) {
  const [steps, setSteps] = useState<EvidenceStep[]>([]);
  const [tests, setTests] = useState<GraphNodeDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!node) {
      setSteps([]);
      setTests([]);
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
  }, [node?.id, repoId]);

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
    <div className="inspector">
      <h2>{node.qualifiedName ?? node.name}</h2>
      <dl className="facts">
        <dt>Type</dt>
        <dd>{node.type}</dd>
        {node.filePath && (
          <>
            <dt>Source</dt>
            <dd className="mono">
              {node.filePath}
              {node.startLine ? `:${node.startLine}` : ""}
              {node.endLine && node.endLine !== node.startLine ? `–${node.endLine}` : ""}
            </dd>
          </>
        )}
      </dl>

      <div className="actions">
        <button onClick={() => onAnalyzeImpact(node.qualifiedName ?? node.name)}>
          Analyze impact
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {split.incoming.length > 0 && (
        <section>
          <h3>Incoming ({split.incoming.length})</h3>
          <ul className="edges">
            {split.incoming.map((s) => (
              <li key={`${s.edge.id}-${node.id}`}>
                <button className="link" onClick={() => onSelect(s.node.id)}>
                  {s.node.name}
                </button>
                <Evidence edge={s} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {split.outgoing.length > 0 && (
        <section>
          <h3>Outgoing ({split.outgoing.length})</h3>
          <ul className="edges">
            {split.outgoing.map((s) => (
              <li key={`${s.edge.id}-${node.id}`}>
                <button className="link" onClick={() => onSelect(s.node.id)}>
                  {s.node.name}
                </button>
                <Evidence edge={s} />
              </li>
            ))}
          </ul>
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

function Evidence({ edge }: { edge: EvidenceStep }) {
  const { edge: e } = edge;
  return (
    <span className="evidence mono">
      {" "}
      <strong>{e.type}</strong> · conf {e.confidence.toFixed(1)}
      {e.evidence.file
        ? ` · ${e.evidence.file}${e.evidence.line ? `:${e.evidence.line}` : ""}`
        : ""}
      {e.evidence.note ? ` · ${e.evidence.note}` : ""}
    </span>
  );
}
