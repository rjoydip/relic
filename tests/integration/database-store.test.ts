import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseClient, SqliteGraphRepository } from "@relic/database";
import type { GraphEdge, GraphNode } from "@relic/graph-core";
import { cleanup, tempDir } from "../helpers";

let dbDir: string;
let client: DatabaseClient;
let repo: SqliteGraphRepository;
const REPO = "repo_db";

function node(id: string, filePath: string, name = id): GraphNode {
  return {
    id,
    repositoryId: REPO,
    type: "symbol",
    name,
    qualifiedName: name,
    filePath,
    startLine: 1,
    endLine: 2,
    metadata: {},
    updatedAt: "now",
  };
}

function edge(sourceId: string, targetId: string): GraphEdge {
  return {
    id: `${sourceId}->${targetId}:CALLS`,
    repositoryId: REPO,
    sourceId,
    targetId,
    type: "CALLS",
    confidence: 1,
    evidence: { source: "static", file: "a.ts", line: 1 },
  };
}

beforeEach(() => {
  dbDir = tempDir();
  client = new DatabaseClient(join(dbDir, "graph.db"));
  repo = new SqliteGraphRepository(client);
  repo.upsertRepository({
    id: REPO,
    name: "db",
    rootPath: "/tmp/db",
    lastRevision: null,
    indexedAt: null,
    indexingDurationMs: null,
    fileCount: 0,
    nodeCount: 0,
    edgeCount: 0,
    diagnostics: [],
  });
});

afterEach(async () => {
  repo.close();
  await cleanup([dbDir]);
});

describe("SQLite graph store", () => {
  it("applies the schema exactly once (versioned migrations)", () => {
    const versions = client.db.prepare("SELECT version FROM schema_migrations").all() as Array<{
      version: number;
    }>;
    expect(versions.map((v) => v.version)).toEqual([1]);
    client.close();
    const again = new DatabaseClient(join(dbDir, "graph.db"));
    expect(
      (again.db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }).c,
    ).toBe(1);
    again.close();
  });

  it("rolls back the whole transaction when any statement fails", () => {
    repo.replaceRepositoryGraph({
      meta: {
        id: REPO,
        name: "db",
        rootPath: "/tmp/db",
        lastRevision: null,
        indexedAt: "now",
        indexingDurationMs: 1,
        fileCount: 1,
        nodeCount: 0,
        edgeCount: 0,
        diagnostics: [],
      },
      files: [{ filePath: "a.ts", nodes: [node("n1", "a.ts")], edges: [] }],
    });
    const before = repo.counts(REPO);

    // Force a failure mid-write.
    client.db.exec(
      "CREATE TRIGGER fail_boom BEFORE INSERT ON nodes WHEN NEW.id = 'boom' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;",
    );
    expect(() =>
      repo.replaceRepositoryGraph({
        meta: {
          id: REPO,
          name: "db",
          rootPath: "/tmp/db",
          lastRevision: null,
          indexedAt: "later",
          indexingDurationMs: 2,
          fileCount: 2,
          nodeCount: 0,
          edgeCount: 0,
          diagnostics: [],
        },
        files: [{ filePath: "b.ts", nodes: [node("boom", "b.ts"), node("n2", "b.ts")], edges: [] }],
      }),
    ).toThrow(/forced failure|ABORT/);

    // Nothing from the failed transaction survived.
    expect(repo.counts(REPO)).toEqual(before);
    expect(repo.getNode("n2")).toBeNull();
    expect(repo.getRepository(REPO)?.indexedAt).toBe("now");

    client.db.exec("DROP TRIGGER fail_boom");
  });

  it("removes stale nodes and edges when a file's graph is replaced", () => {
    const a = node("a1", "a.ts");
    const b = node("b1", "b.ts");
    repo.upsertNode(a);
    repo.upsertNode(b);
    repo.upsertEdge(edge("a1", "b1"));
    expect(repo.getEdges({ sourceIds: ["a1"] })).toHaveLength(1);

    // a.ts re-indexed: symbol a1 renamed to a2.
    const a2 = node("a2", "a.ts");
    repo.replaceFileGraph(REPO, "a.ts", [a2], []);
    expect(repo.getNode("a1")).toBeNull();
    expect(repo.getNode("a2")).not.toBeNull();
    expect(repo.getEdges({ sourceIds: ["a1"] })).toHaveLength(0);
    // Incoming edge from b.ts cascaded with its target.
    expect(repo.getEdges({ targetIds: ["a1"] })).toHaveLength(0);

    // Edges to missing endpoints are skipped, not inserted.
    const dangling = edge("a2", "ghost");
    const { skippedEdges } = repo.replaceRepositoryGraph({
      meta: repo.getRepository(REPO)!,
      files: [{ filePath: "a.ts", nodes: [a2], edges: [dangling] }],
    });
    expect(skippedEdges).toBe(1);
    expect(repo.getEdges({ sourceIds: ["a2"] })).toHaveLength(0);
  });

  it("supports bounded recursive traversal in both directions", () => {
    // c -> b -> a chain
    repo.upsertNode(node("a1", "a.ts"));
    repo.upsertNode(node("b1", "b.ts"));
    repo.upsertNode(node("c1", "c.ts"));
    repo.upsertEdge(edge("b1", "a1"));
    repo.upsertEdge(edge("c1", "b1"));

    const reverse = repo.traverse({
      repositoryId: REPO,
      seedIds: ["a1"],
      direction: "reverse",
      maxDepth: 5,
      limit: 100,
    });
    expect(reverse.map((s) => [s.node.id, s.depth])).toEqual([
      ["b1", 1],
      ["c1", 2],
    ]);
    const bounded = repo.traverse({
      repositoryId: REPO,
      seedIds: ["a1"],
      direction: "reverse",
      maxDepth: 1,
      limit: 100,
    });
    expect(bounded.map((s) => s.node.id)).toEqual(["b1"]);
    const forward = repo.traverse({
      repositoryId: REPO,
      seedIds: ["c1"],
      direction: "forward",
      maxDepth: 3,
      limit: 100,
    });
    expect(forward.map((s) => s.node.id)).toEqual(["b1", "a1"]);
    const filtered = repo.traverse({
      repositoryId: REPO,
      seedIds: ["a1"],
      direction: "reverse",
      maxDepth: 3,
      limit: 100,
      edgeTypes: ["TESTS"],
    });
    expect(filtered).toHaveLength(0);
  });

  it("lists files with content hashes for change detection", () => {
    repo.upsertNode({ ...node("f1", "a.ts"), type: "file", contentHash: "abc" });
    const files = repo.listFiles(REPO);
    expect(files).toEqual([{ filePath: "a.ts", contentHash: "abc" }]);
    const lookups = repo.lookupSymbols(REPO, "f1");
    expect(lookups.map((l) => l.id)).toContain("f1");
  });
});
