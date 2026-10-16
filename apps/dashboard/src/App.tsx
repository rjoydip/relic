import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type GraphEdgeDto,
  type GraphNodeDto,
  type ImpactDto,
  type IndexStatusDto,
  type Repository,
} from "./api";
import { GraphCanvas } from "./GraphCanvas";
import { NodeInspector } from "./NodeInspector";

const NODE_TYPES = [
  "symbol",
  "route",
  "api_operation",
  "frontend_operation",
  "database_table",
  "test",
  "file",
  "queue",
];

export function App() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [status, setStatus] = useState<IndexStatusDto | null>(null);
  const [nodes, setNodes] = useState<GraphNodeDto[]>([]);
  const [edges, setEdges] = useState<GraphEdgeDto[]>([]);
  const [selected, setSelected] = useState<GraphNodeDto | null>(null);
  const [impact, setImpact] = useState<ImpactDto | null>(null);
  const [impactSymbol, setImpactSymbol] = useState("");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repo = repositories.find((r) => r.id === repoId) ?? null;

  const loadGraph = useCallback(async (id: string) => {
    const [nodeList, edgeList, indexStatus] = await Promise.all([
      api.nodes(id),
      api.edges(id),
      api.indexStatus(id),
    ]);
    setNodes(nodeList.nodes);
    setEdges(edgeList.edges);
    setStatus(indexStatus);
  }, []);

  useEffect(() => {
    api
      .repositories()
      .then(async (list) => {
        setRepositories(list.repositories);
        if (list.repositories[0]) {
          setRepoId(list.repositories[0].id);
          await loadGraph(list.repositories[0].id);
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [loadGraph]);

  const analyzeImpact = useCallback(
    async (symbol: string) => {
      if (!repoId || !symbol.trim()) return;
      setBusy(true);
      setError(null);
      try {
        const result = await api.impact(repoId, symbol.trim(), 5);
        setImpact(result);
        setImpactSymbol(symbol.trim());
        setSelected(result.target);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [repoId],
  );

  const reindex = useCallback(async () => {
    if (!repo || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.reindex(repo.id, repo.rootPath);
      await loadGraph(repo.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [repo, busy, loadGraph]);

  const runIndex = useCallback(
    async (source: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await api.indexSource(source);
        const list = await api.repositories();
        setRepositories(list.repositories);
        setRepoId(result.repositoryId);
        await loadGraph(result.repositoryId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [loadGraph],
  );

  const selectNode = useCallback(
    (id: string) => {
      const found = nodes.find((n) => n.id === id);
      if (found) setSelected(found);
      else
        void api
          .node(id)
          .then(setSelected)
          .catch(() => setSelected(null));
    },
    [nodes],
  );

  const affectedIds = useMemo(
    () => new Set((impact?.affected ?? []).map((a) => a.node.id)),
    [impact],
  );

  const visibleNodes = useMemo(
    () =>
      nodes.filter((n) => {
        if (typeFilter && n.type !== typeFilter) return false;
        if (query) {
          const hay = `${n.name} ${n.qualifiedName ?? ""} ${n.filePath ?? ""}`.toLowerCase();
          if (!hay.includes(query.toLowerCase())) return false;
        }
        return true;
      }),
    [nodes, query, typeFilter],
  );

  if (loading) return <div className="center muted">Loading graph…</div>;
  if (!repositories.length)
    return (
      <div className="center">
        <h2>Index a repository</h2>
        <p className="muted">Enter a local path or a GitHub URL to build the graph.</p>
        <IndexForm busy={busy} onIndex={runIndex} />
        {error && <div className="error">{error}</div>}
      </div>
    );

  return (
    <div className="app">
      <header>
        <strong>MCP Dependency Graph</strong>
        <select
          value={repoId ?? ""}
          onChange={(e) => setRepoId(e.target.value)}
          aria-label="Repository"
        >
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <span className="muted mono">{repo?.rootPath}</span>
        <button onClick={() => void reindex()} disabled={busy}>
          {busy ? "Working…" : "Re-index"}
        </button>
        <IndexForm busy={busy} onIndex={runIndex} />
      </header>

      <main>
        <aside className="explorer">
          <h2>Explorer</h2>
          <input
            placeholder="Search nodes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            aria-label="Node type"
          >
            <option value="">All node types</option>
            {NODE_TYPES.filter((t) => nodes.some((n) => n.type === t)).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <h2>Impact</h2>
          <input
            placeholder="Symbol, e.g. UserService.updateUser"
            value={impactSymbol}
            onChange={(e) => setImpactSymbol(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void analyzeImpact(impactSymbol)}
          />
          <button
            onClick={() => void analyzeImpact(impactSymbol)}
            disabled={busy || !impactSymbol.trim()}
          >
            Analyze impact
          </button>

          {impact && (
            <div className="impact-list">
              <p className="muted">
                {impact.summary.affectedSymbols} symbols · {impact.summary.affectedTests} tests ·{" "}
                {impact.summary.unresolvedRelationships} unresolved
              </p>
              <ul>
                {impact.affected.slice(0, 60).map((a) => (
                  <li key={a.node.id}>
                    <button className="link" onClick={() => selectNode(a.node.id)}>
                      {a.node.name}
                    </button>
                    <span className="muted mono">
                      {" "}
                      {a.relationship} d{a.depth} c{a.confidence.toFixed(1)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ul className="node-list">
            {visibleNodes.slice(0, 80).map((n) => (
              <li key={n.id}>
                <button className="link" onClick={() => selectNode(n.id)}>
                  {n.name}
                </button>
                <span className="muted"> {n.type}</span>
              </li>
            ))}
          </ul>
        </aside>

        <section className="canvas">
          {error && <div className="error banner">{error}</div>}
          {visibleNodes.length === 0 ? (
            <div className="center muted">No nodes match the current filters.</div>
          ) : (
            <GraphCanvas
              nodes={visibleNodes}
              edges={edges}
              affectedIds={affectedIds}
              selectedId={selected?.id ?? null}
              onSelect={selectNode}
            />
          )}
        </section>

        <NodeInspector
          repoId={repoId ?? ""}
          node={selected}
          onSelect={selectNode}
          onAnalyzeImpact={(s) => void analyzeImpact(s)}
        />
      </main>

      <footer className="status">
        {status ? (
          <>
            <span>{status.fileCount} files</span>
            <span>{status.nodeCount} nodes</span>
            <span>{status.edgeCount} edges</span>
            <span>{status.durationMs !== null ? `${status.durationMs} ms` : "—"}</span>
            <span className="mono">
              rev {status.lastRevision ? status.lastRevision.slice(0, 10) : "none"}
            </span>
            <span>
              {status.indexedAt
                ? `indexed ${status.indexedAt.slice(0, 19).replace("T", " ")}`
                : "never indexed"}
            </span>
            <span className={status.diagnostics.length > 0 ? "warn" : ""}>
              {status.diagnostics.length} diagnostics
            </span>
          </>
        ) : (
          <span>No index status</span>
        )}
      </footer>
    </div>
  );
}

function IndexForm({
  busy,
  onIndex,
}: {
  busy: boolean;
  onIndex: (source: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="index-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) void onIndex(value.trim());
      }}
    >
      <input
        placeholder="Path or GitHub URL…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Repository source"
      />
      <button type="submit" disabled={busy || !value.trim()}>
        {busy ? "Indexing…" : "Index"}
      </button>
    </form>
  );
}
