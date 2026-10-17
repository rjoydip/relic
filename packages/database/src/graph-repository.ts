import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  NodeFilter,
  NodeType,
  RepositoryMeta,
  TraversalRequest,
  TraversalStep,
} from "@skein/graph-core";
import type { GraphRepository } from "@skein/graph-core";
import type { DatabaseClient } from "./client";

type SqlParam = string | number | null;

interface NodeRow {
  id: string;
  repository_id: string;
  type: NodeType;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  metadata_json: string;
  content_hash: string | null;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  repository_id: string;
  source_id: string;
  target_id: string;
  type: EdgeType;
  confidence: number;
  evidence_json: string;
}

export interface ReplaceGraphInput {
  meta: RepositoryMeta;
  /** Changed (or all, on full index) files with their derived graph records. */
  files: Array<{ filePath: string; nodes: GraphNode[]; edges: GraphEdge[] }>;
  /** Files removed since the last index. */
  deletedFiles?: string[];
}

function toNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    type: row.type,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
  };
}

function toEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type,
    confidence: row.confidence,
    evidence: JSON.parse(row.evidence_json) as GraphEdge["evidence"],
  };
}

export class SqliteGraphRepository implements GraphRepository {
  constructor(private readonly client: DatabaseClient) {}

  private get db() {
    return this.client.db;
  }

  upsertRepository(meta: RepositoryMeta): void {
    this.db
      .prepare(
        `INSERT INTO repositories (id, name, root_path, last_revision, indexed_at, indexing_duration_ms, file_count, diagnostics_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           last_revision = excluded.last_revision,
           indexed_at = excluded.indexed_at,
           indexing_duration_ms = excluded.indexing_duration_ms,
           file_count = excluded.file_count,
           diagnostics_json = excluded.diagnostics_json`,
      )
      .run(
        meta.id,
        meta.name,
        meta.rootPath,
        meta.lastRevision,
        meta.indexedAt,
        meta.indexingDurationMs,
        meta.fileCount,
        JSON.stringify(meta.diagnostics),
      );
  }

  getRepository(id: string): RepositoryMeta | null {
    const row = this.db.prepare("SELECT * FROM repositories WHERE id = ?").get(id) as {
      id: string;
      name: string;
      root_path: string;
      last_revision: string | null;
      indexed_at: string | null;
      indexing_duration_ms: number | null;
      file_count: number;
      diagnostics_json: string;
    } | null;
    if (!row) return null;
    const counts = this.counts(id);
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      lastRevision: row.last_revision,
      indexedAt: row.indexed_at,
      indexingDurationMs: row.indexing_duration_ms,
      fileCount: row.file_count,
      nodeCount: counts.nodes,
      edgeCount: counts.edges,
      diagnostics: JSON.parse(row.diagnostics_json) as RepositoryMeta["diagnostics"],
    };
  }

  listRepositories(): RepositoryMeta[] {
    const rows = this.db.prepare("SELECT id FROM repositories").all() as Array<{ id: string }>;
    return rows
      .map((r) => this.getRepository(r.id)!)
      .filter((r): r is RepositoryMeta => r !== null);
  }

  upsertNode(node: GraphNode): void {
    this.db
      .prepare(
        `INSERT INTO nodes (id, repository_id, type, name, qualified_name, file_path, start_line, end_line, metadata_json, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type, name = excluded.name, qualified_name = excluded.qualified_name,
           file_path = excluded.file_path, start_line = excluded.start_line, end_line = excluded.end_line,
           metadata_json = excluded.metadata_json, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
      )
      .run(
        node.id,
        node.repositoryId,
        node.type,
        node.name,
        node.qualifiedName ?? null,
        node.filePath ?? null,
        node.startLine ?? null,
        node.endLine ?? null,
        JSON.stringify(node.metadata),
        node.contentHash ?? null,
        node.updatedAt,
      );
  }

  upsertEdge(edge: GraphEdge): void {
    this.db
      .prepare(
        `INSERT INTO edges (id, repository_id, source_id, target_id, type, confidence, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, target_id, type) DO UPDATE SET
           confidence = excluded.confidence, evidence_json = excluded.evidence_json`,
      )
      .run(
        edge.id,
        edge.repositoryId,
        edge.sourceId,
        edge.targetId,
        edge.type,
        edge.confidence,
        JSON.stringify(edge.evidence),
      );
  }

  /**
   * One transaction: upsert changed files' nodes, drop stale nodes and
   * file-owned edges, insert regenerated edges. Edges pointing at nodes that
   * do not exist anywhere in the repository are dropped and reported as
   * skipped (never a partially committed graph).
   */
  replaceRepositoryGraph(input: ReplaceGraphInput): { skippedEdges: number } {
    let skippedEdges = 0;
    this.client.tx(() => {
      // Repository row first: nodes/edges reference it (FK).
      this.upsertRepository(input.meta);

      for (const filePath of input.deletedFiles ?? [])
        this.deleteFileGraph(input.meta.id, filePath);

      for (const file of input.files) {
        const existingIds = (
          this.db
            .prepare("SELECT id FROM nodes WHERE repository_id = ? AND file_path = ?")
            .all(input.meta.id, file.filePath) as Array<{ id: string }>
        ).map((r) => r.id);
        const newIds = new Set(file.nodes.map((n) => n.id));
        // File owns its outgoing edges; regenerate them from the new analysis.
        this.db
          .prepare(
            `DELETE FROM edges WHERE repository_id = ? AND source_id IN
               (SELECT id FROM nodes WHERE repository_id = ? AND file_path = ?)`,
          )
          .run(input.meta.id, input.meta.id, file.filePath);
        for (const id of existingIds) {
          if (!newIds.has(id)) this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
        }
        for (const node of file.nodes) this.upsertNode(node);
      }

      const known = new Set(
        (
          this.db
            .prepare("SELECT id FROM nodes WHERE repository_id = ?")
            .all(input.meta.id) as Array<{ id: string }>
        ).map((r) => r.id),
      );
      for (const file of input.files) {
        for (const edge of file.edges) {
          if (!known.has(edge.sourceId) || !known.has(edge.targetId)) {
            skippedEdges++;
            continue;
          }
          this.upsertEdge(edge);
        }
      }

      // Prune database tables whose last referencing edge disappeared.
      this.db
        .prepare(
          `DELETE FROM nodes
           WHERE repository_id = ? AND type = 'database_table'
             AND id NOT IN (SELECT source_id FROM edges WHERE repository_id = ?)
             AND id NOT IN (SELECT target_id FROM edges WHERE repository_id = ?)`,
        )
        .run(input.meta.id, input.meta.id, input.meta.id);
    });
    return { skippedEdges };
  }

  replaceFileGraph(
    repositoryId: string,
    filePath: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): void {
    this.replaceRepositoryGraph({
      meta: this.getRepository(repositoryId) ?? {
        id: repositoryId,
        name: repositoryId,
        rootPath: "",
        lastRevision: null,
        indexedAt: null,
        indexingDurationMs: null,
        fileCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        diagnostics: [],
      },
      files: [{ filePath, nodes, edges }],
    });
  }

  deleteFileGraph(repositoryId: string, filePath: string): void {
    this.db
      .prepare(
        `DELETE FROM edges WHERE repository_id = ? AND source_id IN
           (SELECT id FROM nodes WHERE repository_id = ? AND file_path = ?)`,
      )
      .run(repositoryId, repositoryId, filePath);
    this.db
      .prepare("DELETE FROM nodes WHERE repository_id = ? AND file_path = ?")
      .run(repositoryId, filePath);
  }

  deleteRepository(repositoryId: string): void {
    this.db.prepare("DELETE FROM repositories WHERE id = ?").run(repositoryId);
  }

  getNode(id: string): GraphNode | null {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE id = ?")
      .get(id) as unknown as NodeRow | null;
    return row ? toNode(row) : null;
  }

  listNodes(filter: NodeFilter): GraphNode[] {
    const clauses = ["repository_id = ?"];
    const params: SqlParam[] = [filter.repositoryId];
    if (filter.type) {
      clauses.push("type = ?");
      params.push(filter.type);
    }
    if (filter.filePath) {
      clauses.push("file_path = ?");
      params.push(filter.filePath);
    }
    if (filter.query) {
      clauses.push("(name LIKE ? OR qualified_name LIKE ?)");
      const like = `%${filter.query}%`;
      params.push(like, like);
    }
    const limit = Math.min(filter.limit ?? 50, 500);
    params.push(limit, filter.offset ?? 0);
    const rows = this.db
      .prepare(`SELECT * FROM nodes WHERE ${clauses.join(" AND ")} ORDER BY name LIMIT ? OFFSET ?`)
      .all(...params) as unknown as NodeRow[];
    return rows.map(toNode);
  }

  listFiles(repositoryId: string): Array<{ filePath: string; contentHash: string | null }> {
    return (
      this.db
        .prepare(
          "SELECT file_path, content_hash FROM nodes WHERE repository_id = ? AND type = 'file' AND file_path IS NOT NULL",
        )
        .all(repositoryId) as Array<{ file_path: string; content_hash: string | null }>
    ).map((r) => ({ filePath: r.file_path, contentHash: r.content_hash }));
  }

  lookupSymbols(
    repositoryId: string,
    simpleName: string,
  ): Array<{ id: string; name: string; filePath: string | null; qualifiedName: string | null }> {
    return (
      this.db
        .prepare(
          `SELECT id, name, file_path, qualified_name FROM nodes
           WHERE repository_id = ?
             AND (name = ? OR qualified_name = ? OR qualified_name LIKE '%.' || ?)`,
        )
        .all(repositoryId, simpleName, simpleName, `%.${simpleName}`) as Array<{
        id: string;
        name: string;
        file_path: string | null;
        qualified_name: string | null;
      }>
    ).map((r) => ({
      id: r.id,
      name: r.name,
      filePath: r.file_path,
      qualifiedName: r.qualified_name,
    }));
  }

  getEdges(filter: {
    repositoryId?: string;
    sourceIds?: string[];
    targetIds?: string[];
    edgeTypes?: EdgeType[];
    limit?: number;
  }): GraphEdge[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter.repositoryId) {
      clauses.push("repository_id = ?");
      params.push(filter.repositoryId);
    }
    if (filter.sourceIds?.length) {
      clauses.push(`source_id IN (${filter.sourceIds.map(() => "?").join(",")})`);
      params.push(...filter.sourceIds);
    }
    if (filter.targetIds?.length) {
      clauses.push(`target_id IN (${filter.targetIds.map(() => "?").join(",")})`);
      params.push(...filter.targetIds);
    }
    if (filter.edgeTypes?.length) {
      clauses.push(`type IN (${filter.edgeTypes.map(() => "?").join(",")})`);
      params.push(...filter.edgeTypes);
    }
    if (clauses.length === 0) clauses.push("1 = 1");
    params.push(Math.min(filter.limit ?? 200, 1000));
    const rows = this.db
      .prepare(`SELECT * FROM edges WHERE ${clauses.join(" AND ")} LIMIT ?`)
      .all(...params) as unknown as EdgeRow[];
    return rows.map(toEdge);
  }

  /** Bounded recursive-CTE traversal following edges forward or in reverse. */
  traverse(request: TraversalRequest): TraversalStep[] {
    const typeClause = request.edgeTypes?.length
      ? `AND e.type IN (${request.edgeTypes.map(() => "?").join(",")})`
      : "";
    const joinColumn = request.direction === "reverse" ? "e.target_id" : "e.source_id";
    const nextColumn = request.direction === "reverse" ? "e.source_id" : "e.target_id";
    const maxDepth = Math.max(1, Math.min(request.maxDepth, 10));
    const limit = Math.min(request.limit, 1000);

    const rows = this.db
      .prepare(
        `WITH RECURSIVE walk(node_id, edge_id, depth) AS (
           SELECT value, NULL, 0 FROM json_each(?)
           UNION
           SELECT ${nextColumn}, e.id, w.depth + 1
           FROM walk w
           JOIN edges e ON ${joinColumn} = w.node_id
           WHERE w.depth < ? ${typeClause}
         )
         SELECT w.depth, n.*, e.type AS e_type, e.source_id, e.target_id, e.confidence, e.evidence_json, e.repository_id AS e_repo
         FROM walk w
         JOIN nodes n ON n.id = w.node_id
         JOIN edges e ON e.id = w.edge_id
         WHERE w.depth > 0
         ORDER BY w.depth
         LIMIT ?`,
      )
      .all(
        JSON.stringify(request.seedIds),
        maxDepth,
        ...(request.edgeTypes ?? []),
        limit,
      ) as unknown as Array<
      NodeRow & {
        depth: number;
        e_type: EdgeType;
        source_id: string;
        target_id: string;
        confidence: number;
        evidence_json: string;
        e_repo: string;
      }
    >;

    return rows.map((row) => ({
      depth: row.depth,
      node: toNode(row),
      edge: {
        id: `${row.source_id}->${row.target_id}:${row.e_type}`,
        repositoryId: row.e_repo,
        sourceId: row.source_id,
        targetId: row.target_id,
        type: row.e_type,
        confidence: row.confidence,
        evidence: JSON.parse(row.evidence_json) as GraphEdge["evidence"],
      },
    }));
  }

  counts(repositoryId: string): { nodes: number; edges: number } {
    const nodes = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM nodes WHERE repository_id = ?")
        .get(repositoryId) as { c: number }
    ).c;
    const edges = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM edges WHERE repository_id = ?")
        .get(repositoryId) as { c: number }
    ).c;
    return { nodes, edges };
  }

  close(): void {
    this.client.close();
  }
}
