import { watch } from "node:fs";
import type { GraphUpdateEvent, RelicApp } from "./app";

const IGNORED =
  /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.turbo|out|\.data|test-results)(\/|$)|\.db(?:-wal|-shm)?$/;

/** Build output, dependencies, and VCS metadata never require a re-index. */
export function shouldIgnoreWatchPath(relativePath: string): boolean {
  return relativePath.length === 0 || IGNORED.test(relativePath.replace(/\\/g, "/"));
}

/**
 * Incrementally re-index on file changes (debounced) and push an SSE event.
 * Branch switches are NOT detected — run an explicit index after checkout.
 */
export function startWatcher(app: RelicApp, rootPath: string, debounceMs = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let queued = false;

  const reindex = (): void => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const result = app.graph.indexer.index(rootPath);
      const payload: GraphUpdateEvent = {
        repositoryId: result.repositoryId,
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        revision: result.revision,
        indexedAt: new Date().toISOString(),
      };
      app.events.emit("graph-updated", payload);
      console.error(`re-indexed ${rootPath}: ${result.nodeCount} nodes, ${result.edgeCount} edges`);
    } catch (err) {
      console.error("watch re-index failed:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        reindex();
      }
    }
  };

  const watcher = watch(rootPath, { recursive: true }, (_event, filename) => {
    const relative = String(filename ?? "");
    if (shouldIgnoreWatchPath(relative)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reindex();
    }, debounceMs);
  });
  watcher.on("error", (err) => console.error("watch error:", err));
  console.error(
    `watching ${rootPath} (incremental re-index; branch switches need explicit re-index)`,
  );
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
