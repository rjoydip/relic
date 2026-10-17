import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        last_revision TEXT,
        indexed_at TEXT,
        indexing_duration_ms INTEGER,
        file_count INTEGER NOT NULL DEFAULT 0,
        diagnostics_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT,
        file_path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        content_hash TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(source_id, target_id, type)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_repo_type ON nodes(repository_id, type);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(repository_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(repository_id, qualified_name);
      CREATE INDEX IF NOT EXISTS idx_edges_source_type ON edges(source_id, type);
      CREATE INDEX IF NOT EXISTS idx_edges_target_type ON edges(target_id, type);
    `,
  },
];

/** DB0-agnostic client: connection setup, PRAGMAs, migrations, transactions.
 * Uses node:sqlite (works on both Bun and Node runtimes) behind one class so a
 * different connector only requires changing this adapter. */
export class DatabaseClient {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  /** Rollback on any thrown error — never a partially committed graph. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // transaction already aborted by SQLite
      }
      throw err;
    }
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(
      (
        this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>
      ).map((r) => r.version),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.tx(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      });
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
