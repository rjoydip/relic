import type {
  CouplingMetric,
  CouplingReport,
  CycleReport,
  DeadCodeEntry,
  EdgeType,
  GraphCycle,
  GraphEdge,
  GraphNode,
  ImpactResult,
  NodeFilter,
  NodeType,
  RepositoryMeta,
  RiskAssessment,
  TraversalStep,
} from "./domain";
import { GraphError } from "./errors";
import type { GraphRepository } from "./repository";

const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;
/** Repo-wide scans (cycles, coupling, dead code) are bounded but generous. */
const SCAN_LIMIT = 100_000;
const USAGE_EDGE_TYPES = new Set<EdgeType>(["CALLS", "IMPORTS", "USES_OPERATION", "EXPOSES"]);
const COUPLING_EDGE_TYPES: EdgeType[] = [
  "CALLS",
  "IMPORTS",
  "USES_OPERATION",
  "READS",
  "WRITES",
  "EXPOSES",
  "TESTS",
  "DEPENDS_ON",
  "PUBLISHES",
  "CONSUMES",
];
const TEST_PATH = /(^|\/)(tests?|__tests__)\//;
const ENTRYPOINT_BASENAMES = new Set([
  "index",
  "main",
  "server",
  "app",
  "cli",
  "bootstrap",
  "setup",
]);

/** Edge types that transmit impact upstream (something is affected). */
const IMPACT_EDGE_TYPES: EdgeType[] = [
  "CALLS",
  "EXPOSES",
  "IMPORTS",
  "TESTS",
  "USES_OPERATION",
  "DEPENDS_ON",
  "CONSUMES",
  "PUBLISHES",
];

export class GraphService {
  constructor(private readonly repo: GraphRepository) {}

  searchSymbols(repositoryId: string, query: string, type?: NodeType): GraphNode[] {
    this.requireRepository(repositoryId);
    const filter: NodeFilter = { repositoryId, query };
    if (type) filter.type = type;
    return this.repo.listNodes({ ...filter, limit: DEFAULT_PAGE });
  }

  getSymbolDetails(
    repositoryId: string,
    nodeId: string,
  ): {
    node: GraphNode;
    incoming: Array<{ edge: GraphEdge; node: GraphNode }>;
    outgoing: Array<{ edge: GraphEdge; node: GraphNode }>;
  } {
    const node = this.requireNode(repositoryId, nodeId);
    const incoming = this.repo
      .getEdges({ targetIds: [nodeId], limit: MAX_PAGE })
      .flatMap((edge) => {
        const source = this.repo.getNode(edge.sourceId);
        return source ? [{ edge, node: source }] : [];
      });
    const outgoing = this.repo
      .getEdges({ sourceIds: [nodeId], limit: MAX_PAGE })
      .flatMap((edge) => {
        const target = this.repo.getNode(edge.targetId);
        return target ? [{ edge, node: target }] : [];
      });
    return { node, incoming, outgoing };
  }

  /** Reverse dependencies with the edge, depth, and evidence that proved them. */
  findDependents(
    repositoryId: string,
    nodeId: string,
    maxDepth = 3,
    edgeTypes?: EdgeType[],
  ): TraversalStep[] {
    this.requireNode(repositoryId, nodeId);
    return this.repo.traverse({
      repositoryId,
      seedIds: [nodeId],
      direction: "reverse",
      edgeTypes,
      maxDepth,
      limit: 200,
    });
  }

  /** Forward dependencies with the edge, depth, and evidence that proved them. */
  findDependencies(
    repositoryId: string,
    nodeId: string,
    maxDepth = 3,
    edgeTypes?: EdgeType[],
  ): TraversalStep[] {
    this.requireNode(repositoryId, nodeId);
    return this.repo.traverse({
      repositoryId,
      seedIds: [nodeId],
      direction: "forward",
      edgeTypes,
      maxDepth,
      limit: 200,
    });
  }

  analyzeImpact(
    repositoryId: string,
    targetId: string,
    options: { maxDepth?: number; includeTests?: boolean; includeIndirect?: boolean } = {},
  ): ImpactResult {
    const maxDepth = clamp(options.maxDepth ?? 5, 1, 10);
    const target = this.requireNode(repositoryId, targetId);
    const edgeTypes =
      options.includeTests === false
        ? IMPACT_EDGE_TYPES.filter((t) => t !== "TESTS")
        : IMPACT_EDGE_TYPES;

    const steps = this.repo.traverse({
      repositoryId,
      seedIds: [targetId],
      direction: "reverse",
      edgeTypes,
      maxDepth,
      limit: 500,
    });

    const affected: ImpactResult["affected"] = steps.map((step) => ({
      node: step.node,
      relationship: step.edge.type,
      direction: "upstream",
      depth: step.depth,
      confidence: step.edge.confidence,
      evidence: step.edge.evidence,
    }));

    // includeIndirect: add the target's own outgoing dependencies (what the
    // change may break downstream), one level, de-duplicated.
    if (options.includeIndirect) {
      const seen = new Set([targetId, ...affected.map((a) => a.node.id)]);
      for (const step of this.repo.traverse({
        repositoryId,
        seedIds: [targetId],
        direction: "forward",
        edgeTypes: ["CALLS", "READS", "WRITES", "IMPORTS"],
        maxDepth: 1,
        limit: 200,
      })) {
        if (seen.has(step.node.id)) continue;
        seen.add(step.node.id);
        affected.push({
          node: step.node,
          relationship: step.edge.type,
          direction: "downstream" as const,
          depth: 0,
          confidence: step.edge.confidence,
          evidence: step.edge.evidence,
        });
      }
    }

    affected.sort((a, b) => a.depth - b.depth || b.confidence - a.confidence);

    const meta = this.repo.getRepository(repositoryId);
    const unresolvedRelationships =
      meta?.diagnostics.filter((d) => d.kind === "unresolved").length ?? 0;
    const affectedSymbols = affected.filter((a) => a.node.type === "symbol").length;
    const affectedTests = affected.filter((a) => a.node.type === "test").length;

    return {
      target,
      affected,
      summary: {
        affectedSymbols,
        affectedTests,
        unresolvedRelationships,
        maxDepth,
        risk: assessRisk(affected, affectedSymbols, affectedTests),
      },
    };
  }

  /**
   * Strongly connected components (size >= 2) over IMPORTS/CALLS by default.
   * Iterative Kosaraju: explicit stacks keep large repos off the JS call stack.
   */
  findCycles(repositoryId: string, options: { edgeTypes?: EdgeType[] } = {}): CycleReport {
    this.requireRepository(repositoryId);
    const edgeTypes = options.edgeTypes ?? (["IMPORTS", "CALLS"] as EdgeType[]);
    const nodes = this.repo.listNodes({ repositoryId, limit: SCAN_LIMIT });
    const edges = this.repo.getEdges({ repositoryId, edgeTypes, limit: SCAN_LIMIT });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const adjacency = new Map<string, string[]>();
    const reverse = new Map<string, string[]>();
    for (const node of nodes) {
      adjacency.set(node.id, []);
      reverse.set(node.id, []);
    }
    for (const edge of edges) {
      if (!byId.has(edge.sourceId) || !byId.has(edge.targetId)) continue;
      adjacency.get(edge.sourceId)!.push(edge.targetId);
      reverse.get(edge.targetId)!.push(edge.sourceId);
    }

    // Pass 1: finishing order.
    const visited = new Set<string>();
    const order: string[] = [];
    for (const node of nodes) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      const stack: Array<{ id: string; next: number }> = [{ id: node.id, next: 0 }];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const targets = adjacency.get(frame.id)!;
        if (frame.next < targets.length) {
          const target = targets[frame.next++]!;
          if (!visited.has(target)) {
            visited.add(target);
            stack.push({ id: target, next: 0 });
          }
        } else {
          order.push(frame.id);
          stack.pop();
        }
      }
    }

    // Pass 2: components in reverse finishing order over reversed edges.
    const assigned = new Set<string>();
    const components: string[][] = [];
    for (let i = order.length - 1; i >= 0; i--) {
      const root = order[i]!;
      if (assigned.has(root)) continue;
      assigned.add(root);
      const component: string[] = [];
      const stack = [root];
      while (stack.length > 0) {
        const id = stack.pop()!;
        component.push(id);
        for (const source of reverse.get(id) ?? []) {
          if (assigned.has(source)) continue;
          assigned.add(source);
          stack.push(source);
        }
      }
      components.push(component);
    }

    const cycles: GraphCycle[] = [];
    for (const component of components) {
      if (component.length < 2) continue;
      const ids = new Set(component);
      const members = component.map((id) => byId.get(id)!).sort((a, b) => a.id.localeCompare(b.id));
      cycles.push({
        id: `cycle_${members[0]!.id}`,
        size: members.length,
        nodes: members,
        edges: edges.filter((e) => ids.has(e.sourceId) && ids.has(e.targetId)),
      });
    }
    cycles.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
    return {
      cycles,
      nodeCount: cycles.reduce((sum, cycle) => sum + cycle.size, 0),
    };
  }

  /**
   * Exported symbols with no incoming CALLS/IMPORTS/USES_OPERATION/EXPOSES.
   * Opt-in heuristic: re-exports, reflection, and framework entrypoints are
   * excluded or reported separately, never enforced as a gate.
   */
  findDeadCode(
    repositoryId: string,
    options: { includeTests?: boolean } = {},
  ): { entries: DeadCodeEntry[]; scanned: number } {
    this.requireRepository(repositoryId);
    const nodes = this.repo.listNodes({ repositoryId, limit: SCAN_LIMIT });
    const edges = this.repo.getEdges({ repositoryId, limit: SCAN_LIMIT });
    const incoming = new Map<string, number>();
    for (const edge of edges) {
      if (!USAGE_EDGE_TYPES.has(edge.type)) continue;
      incoming.set(edge.targetId, (incoming.get(edge.targetId) ?? 0) + 1);
    }
    const candidates = nodes.filter(
      (node) =>
        node.type === "symbol" &&
        node.metadata.exported === true &&
        (options.includeTests || !isTestPath(node.filePath)) &&
        !isEntrypointPath(node.filePath),
    );
    const entries: DeadCodeEntry[] = candidates
      .map((node) => ({ node, fanIn: incoming.get(node.id) ?? 0 }))
      .filter((entry) => entry.fanIn === 0)
      .sort(
        (a, b) =>
          (a.node.filePath ?? "").localeCompare(b.node.filePath ?? "") ||
          a.node.name.localeCompare(b.node.name),
      );
    return { entries, scanned: candidates.length };
  }

  /** Coupling for one node over dependency edges in the repository. */
  getNodeCoupling(repositoryId: string, nodeId: string): CouplingMetric {
    const node = this.requireNode(repositoryId, nodeId);
    const edges = this.repo.getEdges({
      repositoryId,
      edgeTypes: COUPLING_EDGE_TYPES,
      limit: SCAN_LIMIT,
    });
    return couplingOf(node, edges);
  }

  /** Per-symbol fan-in/out plus the least stable components. */
  getCouplingReport(repositoryId: string): CouplingReport {
    this.requireRepository(repositoryId);
    const nodes = this.repo.listNodes({ repositoryId, type: "symbol", limit: SCAN_LIMIT });
    const edges = this.repo.getEdges({
      repositoryId,
      edgeTypes: COUPLING_EDGE_TYPES,
      limit: SCAN_LIMIT,
    });
    const metrics = nodes.map((node) => couplingOf(node, edges));
    const average =
      metrics.length === 0
        ? 0
        : metrics.reduce((sum, metric) => sum + metric.instability, 0) / metrics.length;
    const mostCoupled = [...metrics]
      .sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut) || b.instability - a.instability)
      .slice(0, 10);
    return { averageInstability: round2(average), mostCoupled };
  }

  findRelatedTests(repositoryId: string, nodeId: string): GraphNode[] {
    this.requireNode(repositoryId, nodeId);
    const tested = this.repo.traverse({
      repositoryId,
      seedIds: [nodeId],
      direction: "reverse",
      edgeTypes: ["TESTS"],
      maxDepth: 3,
      limit: 100,
    });
    const explicit = tested.map((s) => s.node);
    const seen = new Set(explicit.map((n) => n.id));
    // Fall back to tests of any directly affected symbol.
    for (const step of this.repo.traverse({
      repositoryId,
      seedIds: [nodeId],
      direction: "reverse",
      edgeTypes: ["CALLS", "EXPOSES"],
      maxDepth: 2,
      limit: 100,
    })) {
      for (const test of this.repo.traverse({
        repositoryId,
        seedIds: [step.node.id],
        direction: "reverse",
        edgeTypes: ["TESTS"],
        maxDepth: 2,
        limit: 50,
      })) {
        if (!seen.has(test.node.id)) {
          seen.add(test.node.id);
          explicit.push(test.node);
        }
      }
    }
    return explicit;
  }

  /** Shortest known path of edges from one component to another (BFS). */
  getDependencyPath(
    repositoryId: string,
    fromId: string,
    toId: string,
  ): Array<{ edge: GraphEdge; node: GraphNode }> {
    this.requireNode(repositoryId, fromId);
    this.requireNode(repositoryId, toId);
    const queue: Array<{ id: string; path: Array<{ edge: GraphEdge; node: GraphNode }> }> = [
      { id: fromId, path: [] },
    ];
    const visited = new Set([fromId]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.id === toId) return current.path;
      if (current.path.length >= 8) continue;
      for (const edge of this.repo.getEdges({ sourceIds: [current.id], limit: 100 })) {
        if (visited.has(edge.targetId)) continue;
        visited.add(edge.targetId);
        const node = this.repo.getNode(edge.targetId);
        if (!node) continue;
        queue.push({ id: edge.targetId, path: [...current.path, { edge, node }] });
      }
    }
    return [];
  }

  getSummary(
    repositoryId: string,
  ): RepositoryMeta & { counts: { nodes: number; edges: number }; coupling: CouplingReport } {
    const meta = this.requireRepository(repositoryId);
    return {
      ...meta,
      counts: this.repo.counts(repositoryId),
      coupling: this.getCouplingReport(repositoryId),
    };
  }

  private requireRepository(repositoryId: string): RepositoryMeta {
    const meta = this.repo.getRepository(repositoryId);
    if (!meta)
      throw new GraphError("REPOSITORY_NOT_FOUND", `Repository not indexed: ${repositoryId}`);
    return meta;
  }

  private requireNode(repositoryId: string, nodeId: string): GraphNode {
    const node = this.repo.getNode(nodeId);
    if (!node || node.repositoryId !== repositoryId) {
      throw new GraphError("NODE_NOT_FOUND", `Node not found in repository: ${nodeId}`);
    }
    return node;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Distinct-neighbour fan-in/out; self-edges are ignored. */
function couplingOf(node: GraphNode, edges: GraphEdge[]): CouplingMetric {
  const fanIn = new Set<string>();
  const fanOut = new Set<string>();
  for (const edge of edges) {
    if (edge.targetId === node.id && edge.sourceId !== node.id) fanIn.add(edge.sourceId);
    if (edge.sourceId === node.id && edge.targetId !== node.id) fanOut.add(edge.targetId);
  }
  const ca = fanIn.size;
  const ce = fanOut.size;
  return {
    node,
    fanIn: ca,
    fanOut: ce,
    instability: ca + ce === 0 ? 0 : round2(ce / (ca + ce)),
  };
}

function assessRisk(
  affected: ImpactResult["affected"],
  affectedSymbols: number,
  affectedTests: number,
): RiskAssessment {
  const total = affected.length;
  const inferred = affected.filter((entry) => entry.confidence < 1).length;
  const observedDepth = affected.reduce((max, entry) => Math.max(max, entry.depth), 0);
  const routeExposure = affected.some(
    (entry) => entry.node.type === "route" || entry.node.type === "api_operation",
  );
  const missingTests = affectedSymbols > 0 && affectedTests === 0;
  const factors: RiskAssessment["factors"] = [
    {
      key: "affected",
      label: `${total} affected node${total === 1 ? "" : "s"}`,
      points: Math.round(Math.min(1, total / 20) * 30),
    },
    {
      key: "depth",
      label: `depth ${observedDepth}`,
      points: Math.round(Math.min(1, observedDepth / 5) * 15),
    },
    {
      key: "inferred",
      label: total === 0 ? "no relationships" : `${inferred}/${total} inferred`,
      points: total === 0 ? 0 : Math.round((inferred / total) * 20),
    },
    {
      key: "missingTests",
      label: missingTests ? "no affected tests" : `${affectedTests} affected test(s)`,
      points: missingTests ? 15 : 0,
    },
    {
      key: "routeExposure",
      label: routeExposure ? "route exposure" : "no route exposure",
      points: routeExposure ? 20 : 0,
    },
  ];
  return {
    score: Math.min(
      100,
      factors.reduce((sum, factor) => sum + factor.points, 0),
    ),
    factors,
  };
}

function isTestPath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  return TEST_PATH.test(filePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

function isEntrypointPath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const base = filePath
    .split("/")
    .pop()!
    .replace(/\.[^.]+$/, "");
  if (ENTRYPOINT_BASENAMES.has(base)) return true;
  if (/(^|\/)(pages|app|routes)\//.test(filePath)) return true;
  return /\.config\.[^.]+$/.test(filePath);
}
