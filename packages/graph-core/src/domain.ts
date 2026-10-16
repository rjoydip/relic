export type NodeType =
  | "repository"
  | "file"
  | "symbol"
  | "route"
  | "api_operation"
  | "database_table"
  | "database_query"
  | "queue"
  | "test"
  | "frontend_operation"
  | "service"
  | "deployment";

export type EdgeType =
  | "CONTAINS"
  | "DECLARES"
  | "IMPORTS"
  | "CALLS"
  | "EXPOSES"
  | "READS"
  | "WRITES"
  | "PUBLISHES"
  | "CONSUMES"
  | "TESTS"
  | "USES_OPERATION"
  | "DEPENDS_ON";

/** How a relationship was established. */
export type EvidenceSource = "static" | "inferred" | "runtime";

export interface Evidence {
  source: EvidenceSource;
  file?: string;
  line?: number;
  note?: string;
}

export interface GraphNode {
  id: string;
  repositoryId: string;
  type: NodeType;
  name: string;
  qualifiedName?: string | null;
  filePath?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  metadata: Record<string, unknown>;
  contentHash?: string | null;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  repositoryId: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  confidence: number;
  evidence: Evidence;
}

export type ConfidenceTier = EvidenceSource;

/** Confidence semantics are consistent across analyzers: static facts rank
 * above convention-based inference, runtime observation sits in between. */
export const CONFIDENCE: Record<ConfidenceTier, number> = {
  static: 1.0,
  inferred: 0.6,
  runtime: 0.9,
};

export interface Diagnostic {
  kind: "unresolved" | "parse-error" | "skipped";
  message: string;
  file?: string;
  line?: number;
}

export interface RepositoryMeta {
  id: string;
  name: string;
  rootPath: string;
  lastRevision: string | null;
  indexedAt: string | null;
  indexingDurationMs: number | null;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  diagnostics: Diagnostic[];
}

export interface NodeFilter {
  repositoryId: string;
  type?: NodeType;
  filePath?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface TraversalRequest {
  repositoryId: string;
  seedIds: string[];
  direction: "forward" | "reverse";
  edgeTypes?: EdgeType[] | undefined;
  maxDepth: number;
  limit: number;
}

export interface TraversalStep {
  edge: GraphEdge;
  node: GraphNode;
  depth: number;
}

export interface ImpactResult {
  target: GraphNode;
  affected: Array<{
    node: GraphNode;
    relationship: EdgeType;
    depth: number;
    confidence: number;
    evidence: Evidence;
  }>;
  summary: {
    affectedSymbols: number;
    affectedTests: number;
    unresolvedRelationships: number;
    maxDepth: number;
  };
}
