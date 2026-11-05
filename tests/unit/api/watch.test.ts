import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { RelicApp } from "../../../apps/api/src/app";
import { shouldIgnoreWatchPath, startWatcher } from "../../../apps/api/src/watch";

describe("watch path filter", () => {
  it("ignores dependencies, build output, and VCS metadata", () => {
    for (const path of [
      "node_modules/pkg/index.ts",
      ".git/HEAD",
      "apps/dashboard/dist/index.js",
      "coverage/lcov.info",
      ".next/cache/x",
      "test-results/x",
      "relic.db",
      "relic.db-wal",
      "relic.db-shm",
    ]) {
      expect(shouldIgnoreWatchPath(path)).toBe(true);
    }
  });

  it("re-indexes source and docs changes", () => {
    for (const path of ["src/index.ts", "docs/index.md", "package.json"]) {
      expect(shouldIgnoreWatchPath(path)).toBe(false);
    }
  });
});

describe("watch re-indexing", () => {
  it("re-indexes source changes and emits graph-updated", async () => {
    const root = mkdtempSync(join(tmpdir(), "relic-watch-"));
    const events: unknown[] = [];
    let runs = 0;
    const app = {
      graph: {
        indexer: {
          index: () => {
            runs++;
            return {
              repositoryId: "r",
              nodeCount: 1,
              edgeCount: 2,
              revision: null,
            };
          },
        },
      },
      events: {
        emit: (_name: string, payload: unknown) => events.push(payload),
      },
    } as unknown as RelicApp;

    const stop = startWatcher(app, root, 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(join(root, "a.ts"), "export const a = 1;");
      for (let i = 0; i < 60 && events.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(runs).toBeGreaterThan(0);
      expect(events.length).toBeGreaterThan(0);
    } finally {
      stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
