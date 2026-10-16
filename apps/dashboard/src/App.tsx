import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
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

// curated to carry white button text in both themes
const ACCENTS = [
  "#5e8bff",
  "#8b5cf6",
  "#ec4899",
  "#f43f5e",
  "#f59e0b",
  "#22c55e",
  "#14b8a6",
  "#0ea5e9",
];

function passesFilter(n: GraphNodeDto, query: string, typeFilter: string): boolean {
  if (typeFilter && n.type !== typeFilter) return false;
  if (query) {
    const hay = `${n.name} ${n.qualifiedName ?? ""} ${n.filePath ?? ""}`.toLowerCase();
    if (!hay.includes(query.toLowerCase())) return false;
  }
  return true;
}

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
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("mcpdg-theme") === "light" ? "light" : "dark",
  );
  const [accent, setAccent] = useState(() => localStorage.getItem("mcpdg-accent") ?? "");
  const [accentOpen, setAccentOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("mcpdg-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (accent) {
      document.documentElement.style.setProperty("--accent", accent);
      localStorage.setItem("mcpdg-accent", accent);
    } else {
      document.documentElement.style.removeProperty("--accent");
      localStorage.removeItem("mcpdg-accent");
    }
  }, [accent]);

  const repo = repositories.find((r) => r.id === repoId) ?? null;

  // panel only exists when open AND something is selected — otherwise the
  // graph takes the full width (and no empty inspector column is reserved)
  const showInspector = inspectorOpen && selected !== null;
  const showPeek = !inspectorOpen && selected !== null;

  // Switching repositories invalidates selection, impact and filters —
  // without this reset the old repo's state makes a fresh index look stale.
  useEffect(() => {
    setSelected(null);
    setImpact(null);
    setImpactSymbol("");
    setQuery("");
    setTypeFilter("");
    setError(null);
  }, [repoId]);

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
      // a selection the current filters would hide defeats the point of
      // navigating to it — drop the filters instead
      if (found && !passesFilter(found, query, typeFilter)) {
        setQuery("");
        setTypeFilter("");
      }
      setInspectorOpen(true);
      if (found) setSelected(found);
      else
        void api
          .node(id)
          .then(setSelected)
          .catch(() => setSelected(null));
    },
    [nodes, query, typeFilter],
  );

  const affectedIds = useMemo(
    () => new Set((impact?.affected ?? []).map((a) => a.node.id)),
    [impact],
  );

  const visibleNodes = useMemo(
    () => nodes.filter((n) => passesFilter(n, query, typeFilter)),
    [nodes, query, typeFilter],
  );

  if (loading)
    return (
      <div className="center">
        <div className="spinner" />
        <span className="muted">Loading graph…</span>
      </div>
    );
  if (!repositories.length)
    return (
      <div className="center">
        <div className="hero">
          <h2>Index a repository</h2>
          <p className="muted">Enter a local path or a GitHub URL to build the graph.</p>
          <IndexForm busy={busy} onIndex={runIndex} />
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    );

  return (
    <div className={`app${showInspector ? "" : " inspector-closed"}`}>
      <header>
        <strong className="brand">MCP Dependency Graph</strong>
        <button
          className="icon-btn"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          title="Toggle dark / light theme"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <span className="accent-wrap">
          <button
            className="swatch-btn"
            style={{ "--swatch": accent || "#5e8bff" } as CSSProperties}
            onClick={() => setAccentOpen((o) => !o)}
            title="Accent color"
            aria-label="Accent color"
            aria-haspopup="dialog"
            aria-expanded={accentOpen}
          />
          {accentOpen && (
            <>
              <div className="popover-backdrop" onClick={() => setAccentOpen(false)} />
              <div className="accent-pop" role="group" aria-label="Accent colors">
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    className={`swatch${(accent || "#5e8bff").toLowerCase() === c ? " active" : ""}`}
                    style={{ "--c": c } as CSSProperties}
                    onClick={() => {
                      setAccent(c);
                      setAccentOpen(false);
                    }}
                    aria-label={`Accent ${c}`}
                  />
                ))}
                <button
                  className="swatch reset"
                  onClick={() => {
                    setAccent("");
                    setAccentOpen(false);
                  }}
                  title="Reset accent"
                >
                  ↺
                </button>
              </div>
            </>
          )}
        </span>
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
                    <span className="pill">{a.relationship}</span>
                    <span className="muted mono">
                      d{a.depth} · c{a.confidence.toFixed(1)}
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
                <span className={`pill t-${n.type}`}>{n.type}</span>
              </li>
            ))}
          </ul>
        </aside>

        <section className="canvas">
          {error && <div className="error banner">{error}</div>}
          {showPeek && (
            <button className="peek" onClick={() => setInspectorOpen(true)}>
              ‹ Details
            </button>
          )}
          {visibleNodes.length === 0 ? (
            <div className="center muted">No nodes match the current filters.</div>
          ) : (
            <GraphCanvas
              key={repoId ?? "none"}
              theme={theme}
              nodes={visibleNodes}
              edges={edges}
              affectedIds={affectedIds}
              selectedId={selected?.id ?? null}
              onSelect={selectNode}
            />
          )}
        </section>

        {showInspector && (
          <NodeInspector
            repoId={repoId ?? ""}
            node={selected}
            onSelect={selectNode}
            onAnalyzeImpact={(s) => void analyzeImpact(s)}
            onCollapse={() => setInspectorOpen(false)}
          />
        )}
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
