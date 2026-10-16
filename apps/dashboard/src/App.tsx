import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  api,
  type GraphEdgeDto,
  type GraphNodeDto,
  type ImpactDto,
  type IndexStatusDto,
  type Repository,
} from "./api";
import { GraphCanvas } from "./GraphCanvas";
import { COLOR } from "./layout";
import { NodeInspector } from "./NodeInspector";
import { TREE_ICONS, treeThemeStyles } from "./theme";
import { ancestorsOf, buildTree } from "./tree";

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
  const [analyzing, setAnalyzing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [explorerView, setExplorerView] = useState<"tree" | "flat">(() =>
    localStorage.getItem("mcpdg-explorer") === "flat" ? "flat" : "tree",
  );
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

  useEffect(() => {
    localStorage.setItem("mcpdg-explorer", explorerView);
  }, [explorerView]);

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
      setAnalyzing(true);
      setError(null);
      try {
        const result = await api.impact(repoId, symbol.trim(), 5);
        setImpact(result);
        setImpactSymbol(symbol.trim());
        setSelected(result.target);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setAnalyzing(false);
      }
    },
    [repoId],
  );

  // switching repositories loads the new graph under a canvas overlay — the
  // index/re-index buttons must not light up ("Working…") for an impact
  // analysis or a repo switch, so each action owns its own busy flag
  const switchRepo = useCallback(
    (id: string) => {
      setRepoId(id);
      setSwitching(true);
      loadGraph(id)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSwitching(false));
    },
    [loadGraph],
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

  const explorerTree = useMemo(() => buildTree(visibleNodes), [visibleNodes]);
  // impact results as a tree: one folder per relationship, leaves tagged
  // with their depth
  const impactTree = useMemo(() => {
    if (!impact)
      return { paths: [] as string[], dirs: [] as string[], map: new Map<string, GraphNodeDto>() };
    const paths: string[] = [];
    const map = new Map<string, GraphNodeDto>();
    for (const a of impact.affected) {
      const path = `${a.relationship}/${a.node.name} · d${a.depth}`;
      if (!map.has(path)) {
        map.set(path, a.node);
        paths.push(path);
      }
    }
    const dirs = [...new Set(paths.map((p) => p.slice(0, p.indexOf("/"))))];
    return { paths, dirs, map };
  }, [impact]);

  // tree models are created once, so their handlers read the current maps
  // and selection logic through a ref instead of a stale closure
  const nav = useRef({ select: selectNode, explorer: explorerTree.map, impact: impactTree.map });
  nav.current = { select: selectNode, explorer: explorerTree.map, impact: impactTree.map };

  const explorer = useFileTree({
    paths: explorerTree.paths,
    initialExpansion: "closed",
    icons: TREE_ICONS,
    onSelectionChange: (selected) => {
      const node = nav.current.explorer.get(selected.at(-1) ?? "");
      if (node) nav.current.select(node.id);
    },
  });
  const impactModel = useFileTree({
    paths: impactTree.paths,
    initialExpansion: "open",
    icons: TREE_ICONS,
    onSelectionChange: (selected) => {
      const node = nav.current.impact.get(selected.at(-1) ?? "");
      if (node) nav.current.select(node.id);
    },
  }).model;

  // keep the models in sync with the data; a search expands the ancestors of
  // every match so results are actually visible
  useEffect(() => {
    explorer.model.resetPaths(
      explorerTree.paths,
      query ? { initialExpandedPaths: ancestorsOf(explorerTree.paths) } : undefined,
    );
  }, [explorer.model, explorerTree, query]);
  useEffect(() => {
    impactModel.resetPaths(impactTree.paths, { initialExpandedPaths: impactTree.dirs });
  }, [impactModel, impactTree]);

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
          onChange={(e) => switchRepo(e.target.value)}
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
          <h2>
            Explorer
            <span className="view-toggle">
              <button
                className={explorerView === "tree" ? "on" : ""}
                onClick={() => setExplorerView("tree")}
                title="File tree"
                aria-pressed={explorerView === "tree"}
              >
                🗂
              </button>
              <button
                className={explorerView === "flat" ? "on" : ""}
                onClick={() => setExplorerView("flat")}
                title="Flat list"
                aria-pressed={explorerView === "flat"}
              >
                ☰
              </button>
            </span>
          </h2>
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

          {explorerView === "flat" ? (
            <ul className="node-list">
              {visibleNodes.slice(0, 80).map((n) => (
                <li key={n.id}>
                  <button className="link" onClick={() => selectNode(n.id)}>
                    {n.name}
                  </button>
                  <span className="pill" style={{ color: COLOR[n.type] ?? "#5d6b7f" }}>
                    {n.type}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <FileTree
              model={explorer.model}
              className="graph-tree"
              style={treeThemeStyles(theme, accent || "#5e8bff")}
            />
          )}

          <h2>Impact</h2>
          <input
            placeholder="Symbol, e.g. UserService.updateUser"
            value={impactSymbol}
            onChange={(e) => setImpactSymbol(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void analyzeImpact(impactSymbol)}
          />
          <button
            onClick={() => void analyzeImpact(impactSymbol)}
            disabled={analyzing || !impactSymbol.trim()}
          >
            {analyzing ? "Analyzing…" : "Analyze impact"}
          </button>

          {impact && (
            <>
              <p className="muted impact-summary">
                {impact.target.name} · {impact.summary.affectedSymbols} symbols ·{" "}
                {impact.summary.affectedTests} tests · {impact.summary.unresolvedRelationships}{" "}
                unresolved
              </p>
              <FileTree
                model={impactModel}
                className="graph-tree impact-tree"
                style={treeThemeStyles(theme, accent || "#5e8bff")}
              />
            </>
          )}
        </aside>

        <section className="canvas">
          {switching && (
            <div className="canvas-loader" role="status" aria-label="Loading repository">
              <div className="spinner" />
            </div>
          )}
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
              accent={accent || "#5e8bff"}
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
            <span>
              <StatIcon d={ICON.file} />
              {status.fileCount} files
            </span>
            <span>
              <StatIcon d={ICON.nodes} />
              {status.nodeCount} nodes
            </span>
            <span>
              <StatIcon d={ICON.edges} />
              {status.edgeCount} edges
            </span>
            <span>
              <StatIcon d={ICON.clock} />
              {status.durationMs !== null ? `${status.durationMs} ms` : "—"}
            </span>
            <span className="mono">
              <StatIcon d={ICON.rev} />
              rev {status.lastRevision ? status.lastRevision.slice(0, 10) : "none"}
            </span>
            <span>
              <StatIcon d={ICON.calendar} />
              {status.indexedAt
                ? `indexed ${status.indexedAt.slice(0, 19).replace("T", " ")}`
                : "never indexed"}
            </span>
            <span className={status.diagnostics.length > 0 ? "warn" : ""}>
              <StatIcon d={ICON.warn} />
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

function StatIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ICON = {
  file: "M4 1.8h5l3 3v9.4H4z M9 1.8v3h3",
  nodes: "M3.2 6.2h3.2v3.2H3.2z M9.6 6.2h3.2v3.2H9.6z",
  edges:
    "M6.8 9.2l2.4-2.4 M5.4 7.6L4.2 8.8a2.3 2.3 0 0 0 3.2 3.2l1.2-1.2 M10.6 8.4l1.2-1.2a2.3 2.3 0 0 0-3.2-3.2L7.4 5.2",
  clock: "M8 4.4V8l2.4 1.4 M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0",
  rev: "M5 3v10 M11 3v10 M5 8h6",
  calendar: "M3 4.2h10v8.6H3z M3 7h10 M6 2.4v2.8 M10 2.4v2.8",
  warn: "M8 2.8l5.6 9.6H2.4z M8 6.8v2.6 M8 10.8v.4",
};

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
