import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { openGraph, type OpenGraph } from "@relic/indexer";
import { cleanup, tempDir } from "../../helpers";

const fixtures = join(import.meta.dir, "..", "..", "fixtures");
const libRoot = join(fixtures, "cross-repo", "lib");
const appRoot = join(fixtures, "cross-repo", "app");

let graph: OpenGraph | null = null;
let dbDir: string | null = null;

afterEach(async () => {
  graph?.close();
  if (dbDir) await cleanup([dbDir]);
  graph = null;
  dbDir = null;
});

describe("cross-repository graph", () => {
  it("links a workspace import to a node in another indexed repository", () => {
    dbDir = tempDir();
    graph = openGraph(join(dbDir, "graph.db"));
    const lib = graph.indexer.index(libRoot);
    const app = graph.indexer.index(appRoot);

    const appFile = graph.graph.searchSymbols(app.repositoryId, "src/app.ts", "file")[0]!;
    const imports = graph.repository.getEdges({
      repositoryId: app.repositoryId,
      sourceIds: [appFile.id],
      edgeTypes: ["IMPORTS"],
    });
    expect(imports).toHaveLength(1);
    const target = graph.repository.getNode(imports[0]!.targetId)!;
    expect(target.repositoryId).toBe(lib.repositoryId);
    expect(target.filePath).toBe("src/index.ts");
    expect(imports[0]!.evidence.note).toContain("cross-repository");

    const libFile = graph.repository.getNode(target.id)!;
    const impact = graph.graph.analyzeImpact(lib.repositoryId, libFile.id, { maxDepth: 3 });
    expect(impact.affected.some((row) => row.node.id === appFile.id)).toBe(true);
  });
});
