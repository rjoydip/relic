import { describe, expect, it } from "bun:test";
import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  NodeFilter,
  RepositoryMeta,
  TraversalRequest,
  TraversalStep,
} from "@relic/graph-core";
import { CONFIDENCE, GraphError, GraphService, type GraphRepository } from "@relic/graph-core";

/** In-memory reference repository — also a second implementation of the
 * traversal semantics (BFS with depth bound, type filter, limit). */
class FakeRepository implements GraphRepository {
  nodes = new Map<string, GraphNode>();
  edges: GraphEdge[] = [];
  metas = new Map<string, RepositoryMeta>();

  upsertRepository(meta: RepositoryMeta): void {
    this.metas.set(meta.id, meta);
  }
  getRepository(id: string): RepositoryMeta | null {
    return this.metas.get(id) ?? null;
  }
  listRepositories(): RepositoryMeta[] {
    return [...this.metas.values()];
  }
  upsertNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }
  upsertEdge(edge: GraphEdge): void {
    this.edges.push(edge);
  }
  replaceFileGraph(): void {}
  replaceRepositoryGraph(): { skippedEdges: number } {
    return { skippedEdges: 0 };
  }
  deleteFileGraph(): void {}
  deleteRepository(): void {}
  getNode(id: string): GraphNode | null {
    return this.nodes.get(id) ?? null;
  }
  listNodes(filter: NodeFilter): GraphNode[] {
    return [...this.nodes.values()].filter(
      (n) =>
        n.repositoryId === filter.repositoryId &&
        (!filter.type || n.type === filter.type) &&
        (!filter.filePath || n.filePath === filter.filePath) &&
        (!filter.query || (n.name + (n.qualifiedName ?? "")).includes(filter.query)),
    );
  }
  listFiles(): Array<{ filePath: string; contentHash: string | null }> {
    return [];
  }
  lookupSymbols(): Array<{
    id: string;
    name: string;
    filePath: string | null;
    qualifiedName: string | null;
  }> {
    return [];
  }
  getEdges(filter: {
    sourceIds?: string[];
    targetIds?: string[];
    edgeTypes?: EdgeType[];
    limit?: number;
  }): GraphEdge[] {
    return this.edges
      .filter(
        (e) =>
          (!filter.sourceIds || filter.sourceIds.includes(e.sourceId)) &&
          (!filter.targetIds || filter.targetIds.includes(e.targetId)) &&
          (!filter.edgeTypes || filter.edgeTypes.includes(e.type)),
      )
      .slice(0, filter.limit ?? 200);
  }
  traverse(request: TraversalRequest): TraversalStep[] {
    const steps: TraversalStep[] = [];
    let frontier = [...request.seedIds];
    const visited = new Set(request.seedIds);
    for (let depth = 1; depth <= request.maxDepth && steps.length < request.limit; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of this.edges) {
          if (request.edgeTypes && !request.edgeTypes.includes(edge.type)) continue;
          const fromId = request.direction === "reverse" ? edge.targetId : edge.sourceId;
          const toId = request.direction === "reverse" ? edge.sourceId : edge.targetId;
          if (fromId !== id || visited.has(toId)) continue;
          visited.add(toId);
          const node = this.nodes.get(toId);
          if (!node) continue;
          steps.push({ edge, node, depth });
          next.push(toId);
          if (steps.length >= request.limit) break;
        }
      }
      frontier = next;
    }
    return steps;
  }
  counts(repositoryId: string): { nodes: number; edges: number } {
    return {
      nodes: this.listNodes({ repositoryId }).length,
      edges: this.edges.filter((e) => e.repositoryId === repositoryId).length,
    };
  }
  close(): void {}
}

const REPO = "repo_test";

function node(
  id: string,
  name: string,
  type: GraphNode["type"] = "symbol",
  filePath = "src/x.ts",
): GraphNode {
  return {
    id,
    repositoryId: REPO,
    type,
    name,
    qualifiedName: name,
    filePath,
    startLine: 1,
    endLine: 2,
    metadata: {},
    updatedAt: "now",
  };
}

function edge(source: string, target: string, type: EdgeType, confidence = 1): GraphEdge {
  return {
    id: `${source}->${target}:${type}`,
    repositoryId: REPO,
    sourceId: source,
    targetId: target,
    type,
    confidence,
    evidence: { source: confidence === 1 ? "static" : "inferred", file: "src/x.ts", line: 1 },
  };
}

function fixture(): { repo: FakeRepository; service: GraphService } {
  const repo = new FakeRepository();
  repo.upsertRepository({
    id: REPO,
    name: "test",
    rootPath: "/tmp/test",
    lastRevision: null,
    indexedAt: "now",
    indexingDurationMs: 1,
    fileCount: 1,
    nodeCount: 0,
    edgeCount: 0,
    diagnostics: [{ kind: "unresolved", message: "one dangling" }],
  });
  // target <- caller <- outerCaller, target <- test, target -> dep
  const nodes = ["target", "caller", "outer", "test1", "dep", "route"].map((id) =>
    node(id, id, id === "test1" ? "test" : "symbol"),
  );
  for (const n of nodes) repo.upsertNode(n);
  repo.upsertNode(node("route1", "PATCH /users", "route"));
  repo.upsertEdge(edge("caller", "target", "CALLS"));
  repo.upsertEdge(edge("outer", "caller", "CALLS"));
  repo.upsertEdge(edge("test1", "target", "TESTS"));
  repo.upsertEdge(edge("target", "dep", "READS", CONFIDENCE.inferred));
  repo.upsertEdge(edge("route1", "target", "EXPOSES"));
  return { repo, service: new GraphService(repo) };
}

describe("GraphService.analyzeImpact", () => {
  it("collects direct and transitive dependents with depth and confidence", () => {
    const { service } = fixture();
    const result = service.analyzeImpact(REPO, "target", { maxDepth: 5 });
    const byId = new Map(result.affected.map((a) => [a.node.id, a]));
    expect(byId.get("caller")?.depth).toBe(1);
    expect(byId.get("outer")?.depth).toBe(2);
    expect(byId.get("route1")?.depth).toBe(1);
    expect(byId.get("test1")?.depth).toBe(1);
    expect(byId.get("caller")?.direction).toBe("upstream");
    expect(result.summary.affectedSymbols).toBeGreaterThanOrEqual(2);
    expect(result.summary.affectedTests).toBe(1);
    expect(result.summary.unresolvedRelationships).toBe(1);
    // Affected sorted by depth.
    expect(result.affected[0]?.depth).toBe(1);
  });

  it("bounds traversal depth", () => {
    const { service } = fixture();
    const result = service.analyzeImpact(REPO, "target", { maxDepth: 1 });
    expect(result.affected.map((a) => a.node.id)).not.toContain("outer");
    expect(result.summary.maxDepth).toBe(1);
  });

  it("clamps out-of-range maxDepth", () => {
    const { service } = fixture();
    expect(service.analyzeImpact(REPO, "target", { maxDepth: 99 }).summary.maxDepth).toBe(10);
    expect(service.analyzeImpact(REPO, "target", { maxDepth: 0 }).summary.maxDepth).toBe(1);
  });

  it("excludes tests when includeTests is false", () => {
    const { service } = fixture();
    const result = service.analyzeImpact(REPO, "target", { includeTests: false });
    expect(result.affected.map((a) => a.node.id)).not.toContain("test1");
  });

  it("includeIndirectDependencies adds outgoing dependencies", () => {
    const { service } = fixture();
    const result = service.analyzeImpact(REPO, "target", { includeIndirect: true });
    expect(result.affected.map((a) => a.node.id)).toContain("dep");
    expect(result.affected.find((a) => a.node.id === "dep")?.direction).toBe("downstream");
  });

  it("throws NODE_NOT_FOUND for unknown targets", () => {
    const { service } = fixture();
    expect(() => service.analyzeImpact(REPO, "missing")).toThrowError(GraphError);
  });
});

describe("GraphService traversal helpers", () => {
  it("finds dependents and dependencies", () => {
    const { service } = fixture();
    const dependents = service.findDependents(REPO, "target", 3);
    expect(dependents.map((s) => s.node.id).sort()).toEqual(["caller", "outer", "route1", "test1"]);
    // Evidence travels with each step, not just the node.
    expect(dependents.every((s) => s.depth > 0 && s.edge.evidence !== undefined)).toBe(true);
    expect(service.findDependencies(REPO, "target", 3).map((s) => s.node.id)).toEqual(["dep"]);
  });

  it("finds related tests directly and via callers", () => {
    const { service } = fixture();
    const tests = service.findRelatedTests(REPO, "target").map((n) => n.id);
    expect(tests).toContain("test1");
    // caller's tests: test1 tests target directly; synthesize a caller test.
    const { repo } = fixture();
    repo.upsertNode(node("test2", "caller.test", "test", "tests/caller.test.ts"));
    repo.upsertEdge(edge("test2", "caller", "TESTS"));
    const service2 = new GraphService(repo);
    expect(service2.findRelatedTests(REPO, "caller").map((n) => n.id)).toContain("test2");
    expect(tests.length).toBeGreaterThanOrEqual(1);
  });

  it("returns a shortest dependency path when one exists", () => {
    const { service } = fixture();
    const path = service.getDependencyPath(REPO, "outer", "target");
    expect(path.map((p) => p.node.id)).toEqual(["caller", "target"]);
    expect(service.getDependencyPath(REPO, "target", "outer")).toEqual([]);
  });

  it("reports repository summary and missing repositories", () => {
    const { service } = fixture();
    expect(service.getSummary(REPO).counts.nodes).toBeGreaterThan(0);
    expect(() => service.getSummary("nope")).toThrowError(GraphError);
  });

  it("getSymbolDetails returns incoming and outgoing edges", () => {
    const { service } = fixture();
    const details = service.getSymbolDetails(REPO, "target");
    expect(details.incoming.map((i) => i.edge.type).sort()).toEqual(["CALLS", "EXPOSES", "TESTS"]);
    expect(details.outgoing.map((o) => o.edge.type)).toEqual(["READS"]);
  });
});

function exportedNode(id: string, filePath: string): GraphNode {
  const n = node(id, id, "symbol", filePath);
  n.metadata = { kind: "function", exported: true };
  return n;
}

describe("GraphService analytics", () => {
  it("finds strongly connected components and ignores acyclic tails", () => {
    const { repo, service } = fixture();
    for (const id of ["c1", "c2", "c3"]) repo.upsertNode(node(id, id));
    repo.upsertEdge(edge("c1", "c2", "CALLS"));
    repo.upsertEdge(edge("c2", "c1", "CALLS"));
    repo.upsertEdge(edge("c2", "c3", "CALLS"));
    const report = service.findCycles(REPO);
    expect(report.cycles).toHaveLength(1);
    expect(report.cycles[0]?.size).toBe(2);
    expect(report.cycles[0]?.nodes.map((n) => n.id).sort()).toEqual(["c1", "c2"]);
    expect(report.cycles[0]?.edges).toHaveLength(2);
    expect(report.nodeCount).toBe(2);
  });

  it("scores impact deterministically with a factor breakdown", () => {
    const { service } = fixture();
    const risk = service.analyzeImpact(REPO, "target").summary.risk;
    expect(risk.score).toBeGreaterThan(0);
    expect(risk.score).toBeLessThanOrEqual(100);
    expect(risk.factors.reduce((sum, factor) => sum + factor.points, 0)).toBe(risk.score);
    expect(risk.factors.map((factor) => factor.key)).toEqual([
      "affected",
      "depth",
      "inferred",
      "missingTests",
      "routeExposure",
    ]);
    expect(risk.factors.find((factor) => factor.key === "routeExposure")?.points).toBe(20);
  });

  it("reports per-node and aggregate coupling", () => {
    const { service } = fixture();
    const metric = service.getNodeCoupling(REPO, "target");
    expect(metric.fanIn).toBe(3); // caller, test1, route1
    expect(metric.fanOut).toBe(1); // dep
    expect(metric.instability).toBe(0.25);

    const report = service.getCouplingReport(REPO);
    expect(report.mostCoupled.length).toBeGreaterThan(0);
    expect(report.averageInstability).toBeGreaterThanOrEqual(0);
    expect(service.getSummary(REPO).coupling.mostCoupled.length).toBeGreaterThan(0);
  });

  it("finds unused exports and excludes entrypoints and tests", () => {
    const { repo, service } = fixture();
    repo.upsertNode(exportedNode("unused", "src/lib.ts"));
    repo.upsertNode(exportedNode("used", "src/lib.ts"));
    repo.upsertNode(exportedNode("entry", "src/index.ts"));
    repo.upsertNode(exportedNode("tested", "tests/x.test.ts"));
    repo.upsertEdge(edge("caller", "used", "CALLS"));

    const report = service.findDeadCode(REPO);
    const ids = report.entries.map((entry) => entry.node.id);
    expect(ids).toContain("unused");
    expect(ids).not.toContain("used");
    expect(ids).not.toContain("entry");
    expect(ids).not.toContain("tested");
    expect(
      service.findDeadCode(REPO, { includeTests: true }).entries.map((e) => e.node.id),
    ).toContain("tested");
  });
});
