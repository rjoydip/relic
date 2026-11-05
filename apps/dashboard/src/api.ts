export interface Repository {
  id: string;
  name: string;
  rootPath: string;
  lastRevision: string | null;
  indexedAt: string | null;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
}

export interface GraphNodeDto {
  id: string;
  type: string;
  name: string;
  qualifiedName: string | null;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  /** analyzer payload — symbol nodes carry { kind: class|method|function|variable } */
  metadata?: Record<string, unknown>;
}

export interface GraphEdgeDto {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  confidence: number;
  evidence: { source: string; file?: string; line?: number; note?: string };
}

export interface DiagnosticDto {
  kind: string;
  message: string;
  file?: string;
  line?: number;
}

/** `POST /api/impact` — upstream rows break when the target changes;
 * downstream rows are the target's own direct dependencies. */
export interface ImpactResultDto {
  target: GraphNodeDto;
  affected: Array<{
    node: GraphNodeDto;
    relationship: string;
    direction: "upstream" | "downstream";
    depth: number;
    confidence: number;
    evidence: GraphEdgeDto["evidence"];
  }>;
  summary: {
    affectedSymbols: number;
    affectedTests: number;
    unresolvedRelationships: number;
    maxDepth: number;
    risk: RiskAssessmentDto;
  };
}

export interface RiskFactorDto {
  key: string;
  label: string;
  points: number;
}

/** Deterministic 0-100 blast-radius score; factor points sum to `score`. */
export interface RiskAssessmentDto {
  score: number;
  factors: RiskFactorDto[];
}

export interface CouplingMetricDto {
  fanIn: number;
  fanOut: number;
  instability: number;
}

export interface CycleDto {
  id: string;
  size: number;
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
}

export interface CycleReportDto {
  cycles: CycleDto[];
  nodeCount: number;
}

/** Portable graph export — the header download and the index-screen upload. */
export interface Snapshot {
  format: "relic-snapshot";
  version: 1;
  repository: {
    name: string;
    rootPath: string;
    lastRevision: string | null;
    indexedAt: string | null;
    durationMs: number | null;
    fileCount: number;
    diagnostics: Array<{ kind: string; message: string; file?: string; line?: number }>;
  };
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
}

export interface EvidenceStep {
  edge: GraphEdgeDto;
  node: GraphNodeDto;
}

export interface IndexStatusDto {
  lastRevision: string | null;
  indexedAt: string | null;
  durationMs: number | null;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  diagnostics: DiagnosticDto[];
}

// Static deployments (Cloudflare) have no API of their own; point the build at
// a separately hosted Relic API with VITE_RELIC_API_URL (e.g. https://api.example.com).
const API_ORIGIN = (import.meta.env.VITE_RELIC_API_URL ?? "").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_ORIGIN}/api${path}`, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok)
    throw new Error(
      body.error ? `${body.error}: ${body.message ?? ""}` : `Request failed (${res.status})`,
    );
  return body;
}

export const api = {
  /** SSE stream: `graph-updated` events after any index/re-index. */
  eventsUrl: () => `${API_ORIGIN}/api/events`,
  repositories: () => request<{ repositories: Repository[] }>("/repositories"),
  indexStatus: (repo: string) =>
    request<IndexStatusDto>(`/index-status?repository=${encodeURIComponent(repo)}`),
  cycles: (repo: string) =>
    request<CycleReportDto>(`/cycles?repository=${encodeURIComponent(repo)}`),
  nodes: (repo: string, q?: string, type?: string) =>
    request<{ nodes: GraphNodeDto[] }>(
      `/graph/nodes?repository=${encodeURIComponent(repo)}&limit=2000${q ? `&q=${encodeURIComponent(q)}` : ""}${type ? `&type=${type}` : ""}`,
    ),
  edges: (repo: string) =>
    request<{ edges: GraphEdgeDto[] }>(
      `/graph/edges?repository=${encodeURIComponent(repo)}&limit=5000`,
    ),
  node: (id: string) => request<GraphNodeDto>(`/graph/nodes/${encodeURIComponent(id)}`),
  fileContent: (repo: string, path: string) =>
    request<{ path: string; content: string }>(
      `/repositories/${encodeURIComponent(repo)}/file?path=${encodeURIComponent(path)}`,
    ),
  neighborhood: (id: string) =>
    request<{ nodes: GraphNodeDto[]; steps: EvidenceStep[] }>(
      `/graph/nodes/${encodeURIComponent(id)}/neighborhood?depth=1&limit=200`,
    ),
  relatedTests: (repo: string, symbol: string) =>
    request<{ tests: GraphNodeDto[] }>(
      `/tests/related?repository=${encodeURIComponent(repo)}&symbol=${encodeURIComponent(symbol)}`,
    ),
  impact: (
    repo: string,
    nodeId: string,
    options: { includeTests?: boolean; includeIndirect?: boolean; maxDepth?: number } = {},
  ) =>
    request<ImpactResultDto>("/impact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: repo,
        nodeId,
        includeTests: options.includeTests,
        includeIndirectDependencies: options.includeIndirect,
        maxDepth: options.maxDepth,
      }),
    }),
  indexSource: (source: string) =>
    request<{ repositoryId: string; nodeCount: number; edgeCount: number }>("/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    }),

  deleteRepository: (id: string) =>
    request<{ deleted: string }>(`/repositories/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  snapshot: (repo: string) =>
    request<Snapshot>(`/repositories/${encodeURIComponent(repo)}/snapshot`),
  importSnapshot: (snapshot: Snapshot) =>
    request<{ repositoryId: string; nodeCount: number; edgeCount: number }>("/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    }),

  reindex: (id: string, root: string) =>
    request<{ analyzedFiles: number; nodeCount: number; edgeCount: number }>(
      `/repositories/${encodeURIComponent(id)}/index`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root }),
      },
    ),
};
