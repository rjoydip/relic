import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, tempDir } from "../../helpers";
import { openGraph, repositoryIdFor, type OpenGraph } from "@relic/indexer";

const root = join(import.meta.dir, "..", "..", "fixtures", "infra", "repo");
let graph: OpenGraph | null = null;
let dbDir: string | null = null;

afterEach(async () => {
  graph?.close();
  if (dbDir) await cleanup([dbDir]);
  graph = null;
  dbDir = null;
});

describe("infrastructure graph extraction", () => {
  it("turns pub/sub calls, compose services and k8s references into nodes and edges", () => {
    dbDir = tempDir();
    graph = openGraph(join(dbDir, "graph.db"));
    const result = graph.indexer.index(root);
    const repo = repositoryIdFor(root);

    const queues = graph.repository
      .listNodes({ repositoryId: repo, type: "queue", limit: 50 })
      .map((n) => n.name)
      .sort();
    expect(queues).toEqual(["user.created", "user.deleted"]);

    const publishes = graph.repository.getEdges({
      repositoryId: repo,
      edgeTypes: ["PUBLISHES"],
    });
    const consumes = graph.repository.getEdges({
      repositoryId: repo,
      edgeTypes: ["CONSUMES"],
    });
    expect(publishes).toHaveLength(1);
    expect(consumes).toHaveLength(1);
    expect(publishes[0]!.evidence.source).toBe("static");

    const services = graph.repository
      .listNodes({ repositoryId: repo, type: "service", limit: 50 })
      .map((n) => n.name)
      .sort();
    expect(services).toContain("api");
    expect(services).toContain("db");
    expect(services).toContain("relic/api:latest");

    const deployments = graph.repository
      .listNodes({ repositoryId: repo, type: "deployment", limit: 50 })
      .map((n) => n.name)
      .sort();
    expect(deployments).toContain("relic-api");
    expect(deployments).toContain("root");

    const depends = graph.repository.getEdges({
      repositoryId: repo,
      edgeTypes: ["DEPENDS_ON"],
    });
    expect(depends.length).toBeGreaterThanOrEqual(3);
    expect(depends.every((edge) => edge.evidence.file)).toBe(true);
    expect(result.totalFiles).toBeGreaterThanOrEqual(5);
  });
});
