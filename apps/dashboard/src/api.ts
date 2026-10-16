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
}

export interface GraphEdgeDto {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  confidence: number;
  evidence: { source: string; file?: string; line?: number; note?: string };
}

export interface EvidenceStep {
  edge: GraphEdgeDto;
  node: GraphNodeDto;
}

export interface ImpactDto {
  target: GraphNodeDto;
  affected: Array<{
    node: GraphNodeDto;
    relationship: string;
    depth: number;
    confidence: number;
    evidence: { source: string; file?: string; line?: number; note?: string };
  }>;
  summary: {
    affectedSymbols: number;
    affectedTests: number;
    unresolvedRelationships: number;
    maxDepth: number;
  };
}

export interface IndexStatusDto {
  lastRevision: string | null;
  indexedAt: string | null;
  durationMs: number | null;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  diagnostics: Array<{ kind: string; message: string; file?: string }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok)
    throw new Error(
      body.error ? `${body.error}: ${body.message ?? ""}` : `Request failed (${res.status})`,
    );
  return body;
}

export const api = {
  repositories: () => request<{ repositories: Repository[] }>("/repositories"),
  indexStatus: (repo: string) =>
    request<IndexStatusDto>(`/index-status?repository=${encodeURIComponent(repo)}`),
  nodes: (repo: string, q?: string, type?: string) =>
    request<{ nodes: GraphNodeDto[] }>(
      `/graph/nodes?repository=${encodeURIComponent(repo)}&limit=500${q ? `&q=${encodeURIComponent(q)}` : ""}${type ? `&type=${type}` : ""}`,
    ),
  edges: (repo: string) =>
    request<{ edges: GraphEdgeDto[] }>(
      `/graph/edges?repository=${encodeURIComponent(repo)}&limit=1000`,
    ),
  node: (id: string) => request<GraphNodeDto>(`/graph/nodes/${encodeURIComponent(id)}`),
  neighborhood: (id: string) =>
    request<{ nodes: GraphNodeDto[]; steps: EvidenceStep[] }>(
      `/graph/nodes/${encodeURIComponent(id)}/neighborhood?depth=1&limit=200`,
    ),
  impact: (repo: string, symbol: string, maxDepth: number) =>
    request<ImpactDto>("/impact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: repo, symbol, maxDepth, includeTests: true }),
    }),
  relatedTests: (repo: string, symbol: string) =>
    request<{ tests: GraphNodeDto[] }>(
      `/tests/related?repository=${encodeURIComponent(repo)}&symbol=${encodeURIComponent(symbol)}`,
    ),
  indexSource: (source: string) =>
    request<{ repositoryId: string; nodeCount: number; edgeCount: number }>("/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
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
