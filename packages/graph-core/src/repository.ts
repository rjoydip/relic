import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  NodeFilter,
  RepositoryMeta,
  TraversalRequest,
  TraversalStep,
} from "./domain";

/** Storage contract for graph data. The graph core never depends on a
 * concrete database driver; SQLite/DB0 specifics live in @relic/database. */
export interface GraphRepository {
  upsertRepository(meta: RepositoryMeta): void;
  getRepository(id: string): RepositoryMeta | null;
  listRepositories(): RepositoryMeta[];

  upsertNode(node: GraphNode): void;
  upsertEdge(edge: GraphEdge): void;
  /** Atomically replace all graph records derived from one file. */
  replaceFileGraph(
    repositoryId: string,
    filePath: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): void;
  /** Atomically persist a batch of changed files (and remove deleted ones). */
  replaceRepositoryGraph(input: {
    meta: RepositoryMeta;
    files: Array<{ filePath: string; nodes: GraphNode[]; edges: GraphEdge[] }>;
    deletedFiles?: string[];
  }): { skippedEdges: number };
  deleteFileGraph(repositoryId: string, filePath: string): void;
  deleteRepository(repositoryId: string): void;

  getNode(id: string): GraphNode | null;
  listNodes(filter: NodeFilter): GraphNode[];
  /** All indexed file nodes with their content hashes (change detection). */
  listFiles(repositoryId: string): Array<{ filePath: string; contentHash: string | null }>;
  /** Find symbols whose simple or qualified name matches (cross-file resolution). */
  lookupSymbols(
    repositoryId: string,
    simpleName: string,
  ): Array<{ id: string; name: string; filePath: string | null; qualifiedName: string | null }>;
  getEdges(filter: {
    repositoryId?: string;
    sourceIds?: string[];
    targetIds?: string[];
    edgeTypes?: EdgeType[];
    limit?: number;
  }): GraphEdge[];
  /** Bounded traversal (recursive CTE or equivalent) from seed nodes. */
  traverse(request: TraversalRequest): TraversalStep[];
  counts(repositoryId: string): { nodes: number; edges: number };
  close(): void;
}
