import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { flushSync } from "react-dom";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  ArrowRightIcon,
  BookOpenIcon,
  InfoIcon,
  DownloadIcon,
  FolderGit2Icon,
  FolderTreeIcon,
  LinkIcon,
  ListIcon,
  MoonIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import {
  api,
  type CycleReportDto,
  type GraphEdgeDto,
  type GraphNodeDto,
  type IndexStatusDto,
  type Repository,
  type Snapshot,
} from "./api";
import { GraphCanvas } from "./GraphCanvas";
import { CodeModal, type CodeTarget } from "./CodeModal";
import { MetadataDialog } from "./MetadataDialog";
import { Hint } from "./components/ui/tooltip";
import { COLOR } from "./layout";
import { Logo } from "./Logo";
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
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [indexing, setIndexing] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [explorerView, setExplorerView] = useState<"tree" | "flat">(() =>
    localStorage.getItem("relic-explorer") === "flat" ? "flat" : "tree",
  );
  const [error, setError] = useState<string | null>(null);
  // deployed as static assets only (Cloudflare) — no API behind /api
  const [staticMode, setStaticMode] = useState(false);
  // client-side snapshot (static deployments have no API to import into)
  const [snapshotRepo, setSnapshotRepo] = useState<Repository | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  // node visit trail for back/forward navigation in the details panel
  const [trail, setTrail] = useState<{ ids: string[]; index: number }>({
    ids: [],
    index: -1,
  });
  const [focusToken, setFocusToken] = useState(0);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("relic-theme") === "light" ? "light" : "dark",
  );
  const [code, setCode] = useState<CodeTarget | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [cycles, setCycles] = useState<CycleReportDto | null>(null);
  const [cycleHighlight, setCycleHighlight] = useState<string[]>([]);

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    const doc = document as Document & {
      startViewTransition?: (update: () => void) => void;
    };
    if (doc.startViewTransition)
      doc.startViewTransition(() => {
        // flush so the transition snapshots the *new* palette
        flushSync(() => setTheme(next));
      });
    else setTheme(next);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("relic-theme", theme);
    // the accent picker is gone — drop its persisted value so a stale accent
    // accent from an older build can never override the monochrome theme
    localStorage.removeItem("relic-accent");
    document.documentElement.style.removeProperty("--accent");
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("relic-explorer", explorerView);
  }, [explorerView]);

  const repo = snapshotRepo ?? repositories.find((r) => r.id === repoId) ?? null;

  // Breadcrumb shows the last few path segments so the repo folder (the part
  // that identifies it) survives truncation; the full path is in the title.
  const pathSegments = (repo?.rootPath ?? "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .filter((seg) => !/^[0-9a-f]{8,}$/.test(seg));
  const shownSegments = pathSegments.slice(-3);

  // One side panel: details when a node is selected, otherwise the file
  // explorer. Same place, no layout shift between the two modes.
  const showInspector = panelOpen && inspectorOpen && selected !== null;

  // Switching repositories invalidates selection and filters —
  // without this reset the old repo's state makes a fresh index look stale.
  useEffect(() => {
    setSelected(null);
    setQuery("");
    setTypeFilter("");
    setTrail({ ids: [], index: -1 });
    setError(null);
    setCode(null);
    setMetadataOpen(false);
    setCycles(null);
    setCycleHighlight([]);
  }, [repoId]);

  const loadGraph = useCallback(async (id: string) => {
    const [nodeList, edgeList, indexStatus, cycleReport] = await Promise.all([
      api.nodes(id),
      api.edges(id),
      api.indexStatus(id),
      api.cycles(id).catch(() => null),
    ]);
    setNodes(nodeList.nodes);
    setEdges(edgeList.edges);
    setStatus(indexStatus);
    setCycles(cycleReport);
    setCycleHighlight([]);
  }, []);

  // Live updates: the API pushes one event per index/re-index. Reload the
  // graph only for the repository the dashboard is currently showing.
  useEffect(() => {
    if (staticMode || !repoId) return;
    const source = new EventSource(api.eventsUrl());
    const onUpdate = (event: Event): void => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          repositoryId?: string;
        };
        if (payload.repositoryId === repoId) void loadGraph(repoId);
      } catch {
        // malformed event: ignore and keep the current graph
      }
    };
    source.addEventListener("graph-updated", onUpdate);
    return () => {
      source.removeEventListener("graph-updated", onUpdate);
      source.close();
    };
  }, [repoId, staticMode, loadGraph]);

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
      .catch((err: unknown) => {
        if (err instanceof Error && /Request failed \(404\)/.test(err.message)) setStaticMode(true);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [loadGraph]);

  // switching repositories loads the new graph under a canvas overlay — the
  // index/re-index buttons must not light up for a repo switch
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
    if (!repo || reindexing) return;
    setReindexing(true);
    setError(null);
    try {
      await api.reindex(repo.id, repo.rootPath);
      await loadGraph(repo.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReindexing(false);
    }
  }, [repo, reindexing, loadGraph]);

  const runIndex = useCallback(
    async (source: string) => {
      setIndexing(true);
      setError(null);
      try {
        const result = await api.indexSource(source);
        const list = await api.repositories();
        setRepositories(list.repositories);
        setRepoId(result.repositoryId);
        await loadGraph(result.repositoryId);
      } catch (err) {
        if (err instanceof Error && /Request failed \(404\)/.test(err.message)) setStaticMode(true);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIndexing(false);
      }
    },
    [loadGraph],
  );

  const selectNode = useCallback(
    (id: string, fromGraph = false) => {
      // clicking a card must not pan the graph; only navigation from the tree,
      // search or inspector asks the canvas to focus the node
      if (!fromGraph) setFocusToken((t) => t + 1);
      const found = nodes.find((n) => n.id === id);
      // a selection the current filters would hide defeats the point of
      // navigating to it — drop the filters instead
      if (found && !passesFilter(found, query, typeFilter)) {
        setQuery("");
        setTypeFilter("");
      }
      setInspectorOpen(true);
      setPanelOpen(true);
      setTrail((t) => {
        const ids = t.ids.slice(0, t.index + 1);
        if (ids[ids.length - 1] === id) return t;
        const next = [...ids, id].slice(-50);
        return { ids: next, index: next.length - 1 };
      });
      // the file viewer is opt-in (icon button in the inspector), never a
      // side effect of selecting a node
      if (found) setSelected(found);
      else
        void api
          .node(id)
          .then(setSelected)
          .catch(() => setSelected(null));
    },
    [nodes, query, typeFilter],
  );

  const navigateTrail = useCallback(
    (delta: number) => {
      const index = trail.index + delta;
      if (index < 0 || index >= trail.ids.length) return;
      const id = trail.ids[index];
      if (!id) return;
      setTrail({ ...trail, index });
      setInspectorOpen(true);
      setPanelOpen(true);
      setFocusToken((t) => t + 1);
      const found = nodes.find((n) => n.id === id);
      if (found) setSelected(found);
      else
        void api
          .node(id)
          .then(setSelected)
          .catch(() => {});
    },
    [trail, nodes],
  );

  // clear the dashboard entirely and land back on the index screen; indexed
  // repositories stay in the history list below the form
  const resetView = useCallback(() => {
    localStorage.removeItem("relic-explorer");
    setRepoId(null);
    setSelected(null);
    setQuery("");
    setTypeFilter("");
    setNodes([]);
    setEdges([]);
    setStatus(null);
    setInspectorOpen(true);
    setPanelOpen(true);
    setTrail({ ids: [], index: -1 });
    setSnapshotRepo(null);
    setError(null);
    setCycles(null);
    setCycleHighlight([]);
  }, []);

  const removeRepository = useCallback(
    async (id: string) => {
      try {
        await api.deleteRepository(id);
        setRepositories((list) => list.filter((r) => r.id !== id));
        if (repoId === id) resetView();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [repoId, resetView],
  );

  const snapshotInput = useRef<HTMLInputElement>(null);

  const downloadSnapshot = useCallback(async () => {
    if (!repoId) return;
    try {
      const snapshot = await api.snapshot(repoId);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${repo?.name ?? "relic"}-snapshot.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [repoId, repo]);

  const loadSnapshot = useCallback(
    async (file: File) => {
      setIndexing(true);
      setError(null);
      try {
        const snapshot = JSON.parse(await file.text()) as Snapshot;
        if (staticMode) {
          const id = `snapshot:${snapshot.repository.name}`;
          setSnapshotRepo({
            id,
            name: snapshot.repository.name,
            rootPath: snapshot.repository.rootPath,
            lastRevision: snapshot.repository.lastRevision,
            indexedAt: snapshot.repository.indexedAt,
            fileCount: snapshot.repository.fileCount,
            nodeCount: snapshot.nodes.length,
            edgeCount: snapshot.edges.length,
          });
          setRepositories([]);
          setRepoId(id);
          setNodes(snapshot.nodes);
          setEdges(snapshot.edges);
          setStatus({
            lastRevision: snapshot.repository.lastRevision,
            indexedAt: snapshot.repository.indexedAt,
            durationMs: snapshot.repository.durationMs,
            fileCount: snapshot.repository.fileCount,
            nodeCount: snapshot.nodes.length,
            edgeCount: snapshot.edges.length,
            diagnostics: snapshot.repository.diagnostics,
          });
          setCycles(null);
          setCycleHighlight([]);
          return;
        }
        const result = await api.importSnapshot(snapshot);
        const list = await api.repositories();
        setRepositories(list.repositories);
        setRepoId(result.repositoryId);
        await loadGraph(result.repositoryId);
      } catch (err) {
        if (err instanceof Error && /Request failed \(404\)/.test(err.message)) setStaticMode(true);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIndexing(false);
      }
    },
    [loadGraph, staticMode],
  );

  // Keep typing responsive on large graphs: the tree/graph catch up a frame later.
  const deferredQuery = useDeferredValue(query);
  const visibleNodes = useMemo(
    () => nodes.filter((n) => passesFilter(n, deferredQuery, typeFilter)),
    [nodes, deferredQuery, typeFilter],
  );

  const explorerTree = useMemo(() => buildTree(visibleNodes), [visibleNodes]);

  // tree models are created once, so their handlers read the current maps
  // and selection logic through a ref instead of a stale closure
  const nav = useRef({ select: selectNode, explorer: explorerTree.map });
  nav.current = { select: selectNode, explorer: explorerTree.map };
  // set while the inspector drives the tree so it does not bounce selection back
  const syncingTree = useRef(false);

  const explorer = useFileTree({
    paths: explorerTree.paths,
    initialExpansion: "closed",
    icons: TREE_ICONS,
    onSelectionChange: (selected) => {
      if (syncingTree.current) return;
      const node = nav.current.explorer.get(selected.at(-1) ?? "");
      if (node) nav.current.select(node.id);
    },
  });

  // keep the model in sync with the data; a search expands the ancestors of
  // every match so results are actually visible
  useEffect(() => {
    explorer.model.resetPaths(
      explorerTree.paths,
      query ? { initialExpandedPaths: ancestorsOf(explorerTree.paths) } : undefined,
    );
  }, [explorer.model, explorerTree, query]);

  // selecting a node (graph, relationship list, related test) reveals its file
  useEffect(() => {
    const file = selected?.filePath;
    if (!file) return;
    syncingTree.current = true;
    try {
      const parts = file.split("/");
      let dir = "";
      for (let i = 0; i < parts.length - 1; i += 1) {
        dir = dir ? `${dir}/${parts[i]}` : (parts[i] ?? "");
        const handle = explorer.model.getItem(dir);
        if (handle && "expand" in handle) handle.expand();
      }
      explorer.model.getItem(file)?.select();
      explorer.model.scrollToPath(file, { focus: true });
    } catch {
      // the file is filtered out of the current tree — nothing to focus
    }
    // the tree emits synchronously; clear on the next tick just in case
    setTimeout(() => {
      syncingTree.current = false;
    }, 0);
  }, [selected?.filePath, explorer.model, explorerTree]);

  if (loading) return <LoadingOverlay label="Loading dependency graph…" />;
  const brandButton = (
    <Hint label="Reset dashboard">
      <button type="button" className="brand" onClick={resetView} aria-label="Reset dashboard">
        <Logo className="brand-logo" />
        Relic
      </button>
    </Hint>
  );

  const headerActions = (
    <span className="header-actions">
      <Hint label="Documentation">
        <a className="docs-link" href="/docs/">
          <BookOpenIcon />
          <span>Docs</span>
        </a>
      </Hint>
      {repoId && !staticMode && (
        <Hint label="Re-index repository">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void reindex()}
            disabled={reindexing}
            aria-label="Re-index repository"
          >
            {reindexing ? <span className="spinner mini" /> : <RefreshIcon />}
          </Button>
        </Hint>
      )}
      {repoId && !staticMode && (
        <Hint label="Download snapshot">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void downloadSnapshot()}
            aria-label="Download snapshot"
          >
            <DownloadIcon />
          </Button>
        </Hint>
      )}
      {repoId && status && (
        <Hint label="Metadata">
          <Button
            variant="ghost"
            size="icon-sm"
            className="diag-trigger"
            onClick={() => setMetadataOpen(true)}
            aria-label="Show metadata"
          >
            <InfoIcon />
          </Button>
        </Hint>
      )}
      <Hint label="Toggle dark / light theme">
        <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </Button>
      </Hint>
    </span>
  );

  if (!repoId)
    return (
      <div className="app">
        <header>
          {brandButton}
          {headerActions}
        </header>
        <div className="center-stage">
          <div className="hero">
            <h2>{staticMode ? "Explore a snapshot" : "Build a dependency graph"}</h2>
            {staticMode ? (
              <p className="static-note">
                This hosted dashboard is read-only. Load a <code>.json</code> snapshot exported from
                Relic to browse its dependency graph — indexing and re-indexing run in the local
                app. Use <strong>Download snapshot</strong> there to create one.
              </p>
            ) : (
              <>
                <p className="muted">
                  Point Relic at a local folder or a public GitHub repository. It maps files,
                  routes, classes, calls and tests into one graph — local paths never leave your
                  machine.
                </p>
                <IndexForm busy={indexing} onIndex={runIndex} />
              </>
            )}
            <div className="hero-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() => snapshotInput.current?.click()}
                disabled={indexing}
              >
                <UploadIcon /> Load snapshot
              </Button>
              <input
                ref={snapshotInput}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void loadSnapshot(file);
                  e.target.value = "";
                }}
              />
            </div>
            {error && !staticMode && <div className="error">{error}</div>}
            {repositories.length > 0 && (
              <section className="repo-history">
                <h3>Indexed repositories ({repositories.length})</h3>
                <ul>
                  {repositories.map((r) => (
                    <li key={r.id}>
                      <button className="link" onClick={() => switchRepo(r.id)}>
                        {r.name}
                      </button>
                      <span className="muted mono">
                        {r.fileCount} files · {r.nodeCount} nodes
                      </span>
                      <Hint label="Delete index">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="repo-delete"
                          onClick={() => void removeRepository(r.id)}
                          aria-label={`Delete ${r.name} index`}
                        >
                          <Trash2Icon />
                        </Button>
                      </Hint>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
        {indexing && <LoadingOverlay label="Building dependency graph…" />}
      </div>
    );

  return (
    <div className={`app${panelOpen ? "" : " panel-closed"}`}>
      <header>
        {brandButton}
        {!staticMode && <IndexForm busy={indexing} onIndex={runIndex} />}
        {/* breadcrumb: full path in faded segments, the repo folder (the
            app name) emphasised; GitHub clones stage into a hashed temp
            dir — that segment never shows */}
        <Hint side="bottom" label={repo?.rootPath ?? "Repository path"}>
          <Breadcrumb className="path-chip mono">
            <BreadcrumbList>
              <BreadcrumbItem>
                <svg className="path-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M1.8 4.2c0-.8.6-1.4 1.4-1.4h3l1.6 1.8h5c.8 0 1.4.6 1.4 1.4v6c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                  />
                </svg>
              </BreadcrumbItem>
              {pathSegments.length > shownSegments.length && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <span className="path-ellipsis">…</span>
                  </BreadcrumbItem>
                </>
              )}
              {shownSegments.map((seg, i) => (
                <Fragment key={`${seg}-${i}`}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    {i === shownSegments.length - 1 ? (
                      <BreadcrumbPage>{seg}</BreadcrumbPage>
                    ) : (
                      <span>{seg}</span>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </Hint>
        {headerActions}
      </header>

      <main>
        <section className="canvas">
          {!panelOpen && (
            <Hint label="Show panel">
              <Button
                variant="outline"
                size="icon"
                className="panel-peek"
                onClick={() => setPanelOpen(true)}
                aria-label="Show side panel"
              >
                <PanelRightOpenIcon />
              </Button>
            </Hint>
          )}
          {switching && (
            <div className="canvas-loader" role="status" aria-label="Loading repository">
              <div className="spinner" />
            </div>
          )}
          {error && <div className="error banner">{error}</div>}
          {visibleNodes.length === 0 ? (
            <div className="center-stage muted">No nodes match the current filters.</div>
          ) : (
            <GraphCanvas
              key={repoId ?? "none"}
              theme={theme}
              focusToken={focusToken}
              nodes={visibleNodes}
              edges={edges}
              selectedId={selected?.id ?? null}
              highlightIds={cycleHighlight}
              onSelect={selectNode}
            />
          )}
        </section>

        {panelOpen &&
          (showInspector ? (
            <NodeInspector
              repoId={repoId ?? ""}
              node={selected}
              offline={staticMode}
              nodes={nodes}
              edges={edges}
              canGoBack={trail.index > 0}
              canGoForward={trail.index >= 0 && trail.index < trail.ids.length - 1}
              onBack={() => navigateTrail(-1)}
              onForward={() => navigateTrail(1)}
              onSelect={selectNode}
              onCollapse={() => setInspectorOpen(false)}
              onHidePanel={() => setPanelOpen(false)}
              onOpenCode={setCode}
              cycles={cycles}
              onHighlightCycle={(ids) => {
                // a cycle spans files the current search may hide — show it all
                setQuery("");
                setTypeFilter("");
                setCycleHighlight(ids);
                setFocusToken((t) => t + 1);
              }}
              highlightedCycle={cycleHighlight}
            />
          ) : (
            <aside className="explorer">
              {staticMode ? (
                <span className="repo-trigger repo-static">
                  <FolderGit2Icon />
                  <span className="repo-trigger-name">{repo?.name ?? "Snapshot"}</span>
                </span>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full justify-between font-normal"
                      />
                    }
                  >
                    <span className="repo-trigger">
                      <FolderGit2Icon />
                      <span className="repo-trigger-name">{repo?.name ?? "Repository"}</span>
                      {repo && (
                        <span className="repo-trigger-hash">
                          ({repo.id.replace(/^repo_/, "").slice(0, 7)})
                        </span>
                      )}
                    </span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[var(--anchor-width)]">
                    <DropdownMenuRadioGroup
                      value={repoId ?? ""}
                      onValueChange={(id) => id && switchRepo(id)}
                    >
                      {repositories.map((r) => (
                        <DropdownMenuRadioItem key={r.id} value={r.id}>
                          <span className="repo-trigger">
                            <FolderGit2Icon />
                            <span className="repo-trigger-name">{r.name}</span>
                            <span className="repo-trigger-hash">
                              ({r.id.replace(/^repo_/, "").slice(0, 7)})
                            </span>
                          </span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <h2>
                <span className="explorer-title">
                  Files <span className="count">{visibleNodes.length}</span>
                </span>
                <span className="explorer-actions">
                  <ToggleGroup
                    value={[explorerView]}
                    onValueChange={(v) => {
                      const picked = v[0];
                      if (picked === "tree" || picked === "flat") setExplorerView(picked);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Hint label="File tree">
                      <ToggleGroupItem value="tree" aria-label="File tree">
                        <FolderTreeIcon />
                      </ToggleGroupItem>
                    </Hint>
                    <Hint label="Flat list">
                      <ToggleGroupItem value="flat" aria-label="Flat list">
                        <ListIcon />
                      </ToggleGroupItem>
                    </Hint>
                  </ToggleGroup>
                  {selected && (
                    <Hint label="Show details">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setInspectorOpen(true)}
                        aria-label="Show details"
                      >
                        <PanelRightOpenIcon />
                      </Button>
                    </Hint>
                  )}
                  <Hint label="Hide panel">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setPanelOpen(false)}
                      aria-label="Hide panel"
                    >
                      <PanelRightCloseIcon />
                    </Button>
                  </Hint>
                </span>
              </h2>

              <div className="explorer-toolbar">
                <div className="field">
                  <svg className="field-icon" viewBox="0 0 16 16" aria-hidden="true">
                    <circle
                      cx="7"
                      cy="7"
                      r="4.2"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M10.2 10.2 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                  <Input
                    placeholder="Search nodes…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Search nodes"
                  />
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full justify-between font-normal"
                      />
                    }
                  >
                    {typeFilter ? typeFilter.replace(/_/g, " ") : "All types"}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[var(--anchor-width)]">
                    <DropdownMenuRadioGroup
                      value={typeFilter}
                      onValueChange={(t) => setTypeFilter(t ?? "")}
                    >
                      <DropdownMenuRadioItem value="">All types</DropdownMenuRadioItem>
                      {NODE_TYPES.filter((t) => nodes.some((n) => n.type === t)).map((t) => (
                        <DropdownMenuRadioItem key={t} value={t}>
                          {t.replace(/_/g, " ")}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

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
                  style={treeThemeStyles(theme)}
                />
              )}
            </aside>
          ))}
      </main>

      <MetadataDialog
        open={metadataOpen}
        onOpenChange={(next) => {
          // Keep metadata open behind the file viewer; Escape/outside-click
          // in the code modal must not take the metadata panel with it.
          if (!next && code) return;
          setMetadataOpen(next);
        }}
        status={status}
        repoName={repo?.name ?? null}
        repoPath={repo?.rootPath ?? null}
        diagnostics={status?.diagnostics ?? []}
        offline={staticMode}
        onOpenCode={setCode}
      />

      {code && <CodeModal repoId={repoId ?? ""} code={code} onClose={() => setCode(null)} />}

      {indexing && <LoadingOverlay label="Building dependency graph…" />}
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M13.3 8a5.3 5.3 0 1 1-1.55-3.75M13.5 2.5V6H10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LoadingOverlay({ label }: { label: string }) {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <div className="loading-card">
        <Logo className="loading-logo" />
        <span className="loading-title">Relic</span>
        <span className="loading-label">{label}</span>
        <span className="loading-bar" aria-hidden="true">
          <i />
        </span>
      </div>
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
      <div className="index-field">
        <LinkIcon className="index-field-icon" />
        <input
          className="index-input"
          placeholder="Local path or GitHub URL…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Repository source"
        />
        <Hint label="Index repository">
          <Button
            type="submit"
            size="icon-sm"
            className="index-submit"
            disabled={busy || !value.trim()}
            aria-label="Index repository"
          >
            {busy ? <span className="spinner mini" /> : <ArrowRightIcon />}
          </Button>
        </Hint>
      </div>
    </form>
  );
}
