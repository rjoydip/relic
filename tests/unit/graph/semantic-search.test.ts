import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openGraph, repositoryIdFor, type OpenGraph } from "@relic/indexer";
import { cleanup, copyFixture, tempDir } from "../../helpers";

let fixture: { root: string; cleanup: () => void };
let dbDir: string;
let graph: OpenGraph;
let repoId: string;

beforeEach(() => {
  fixture = copyFixture();
  dbDir = tempDir();
  graph = openGraph(join(dbDir, "graph.db"));
  repoId = repositoryIdFor(fixture.root);
  graph.indexer.index(fixture.root);
});

afterEach(async () => {
  graph.close();
  fixture.cleanup();
  await cleanup([dbDir]);
});

describe("semantic search", () => {
  it("ranks the symbol a natural-language query describes", () => {
    const report = graph.graph.semanticSearch(repoId, "where does the user service update a user");
    expect(report.mode).toBe("ranked");
    expect(report.hits.length).toBeGreaterThan(0);
    const top = report.hits[0]!;
    expect(top.node.qualifiedName).toContain("updateUser");
    expect(top.evidence.file).toContain("src/");
    expect(top.evidence.line).toBeGreaterThan(0);
    expect(top.score).toBeGreaterThan(0);
  });

  it("falls back to keyword search when nothing is ranked", () => {
    const report = graph.graph.semanticSearch(repoId, "zzzz-no-such-symbol");
    expect(report.mode).toBe("keyword");
    expect(report.hits).toHaveLength(0);
  });

  it("returns keyword matches for a plain substring query", () => {
    const report = graph.graph.semanticSearch(repoId, "UserService");
    expect(report.mode).toBe("ranked");
    expect(report.hits.some((hit) => hit.node.qualifiedName === "UserService.updateUser")).toBe(
      true,
    );
  });
});
