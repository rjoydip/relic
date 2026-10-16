import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  ImpactResult,
  NodeFilter,
  NodeType,
  RepositoryMeta,
} from "./domain";
import { GraphError } from "./errors";
import type { GraphRepository } from "./repository";

const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;

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

  findDependents(
    repositoryId: string,
    nodeId: string,
    maxDepth = 3,
    edgeTypes?: EdgeType[],
  ): GraphNode[] {
    this.requireNode(repositoryId, nodeId);
    return this.repo
      .traverse({
        repositoryId,
        seedIds: [nodeId],
        direction: "reverse",
        edgeTypes,
        maxDepth,
        limit: 200,
      })
      .map((step) => step.node);
  }

  findDependencies(
    repositoryId: string,
    nodeId: string,
    maxDepth = 3,
    edgeTypes?: EdgeType[],
  ): GraphNode[] {
    this.requireNode(repositoryId, nodeId);
    return this.repo
      .traverse({
        repositoryId,
        seedIds: [nodeId],
        direction: "forward",
        edgeTypes,
        maxDepth,
        limit: 200,
      })
      .map((step) => step.node);
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

    const affected = steps.map((step) => ({
      node: step.node,
      relationship: step.edge.type,
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

    return {
      target,
      affected,
      summary: {
        affectedSymbols: affected.filter((a) => a.node.type === "symbol").length,
        affectedTests: affected.filter((a) => a.node.type === "test").length,
        unresolvedRelationships,
        maxDepth,
      },
    };
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

  getSummary(repositoryId: string): RepositoryMeta & { counts: { nodes: number; edges: number } } {
    const meta = this.requireRepository(repositoryId);
    return { ...meta, counts: this.repo.counts(repositoryId) };
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
