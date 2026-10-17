# Relic — Detailed Implementation Plan

## 1. Project vision

Build a TypeScript-based **Relic** application that understands how an application's code, APIs, database, tests, frontend, and deployments are connected.

Instead of exposing isolated repository tools, the MCP server constructs a refreshable dependency graph that coding agents can query to understand the impact of code changes.

Example question:

> What breaks if I change `UserService.updateUser()`?

The system should identify direct and indirect callers, API routes, GraphQL resolvers, WebSocket actions, database dependencies, frontend operations, and relevant tests. Each result should include source evidence and a confidence level.

The product has two primary interfaces:

1. **MCP server:** allows compatible coding agents to query repository relationships and analyze changes.
2. **Developer dashboard:** visualizes the same graph so developers can search, explore, filter, and inspect dependencies interactively.

## 2. Requirements and technology decisions

| Area                                         | Technology / decision                               | Purpose                                                             |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| Language                                     | TypeScript, strict mode                             | Shared types and implementation                                     |
| Runtime                                      | Bun                                                 | Run TypeScript services and the MCP server                          |
| Package manager                              | Bun                                                 | Install dependencies and manage workspaces                          |
| Development workflow / quality orchestration | Vite+ (`vp`)                                        | Coordinate formatting, linting, tests, and builds                   |
| Reference repository                         | `starter-hono`                                      | Initial repository to index and use for integration fixtures        |
| Backend framework                            | Hono + TypeScript                                   | Dashboard API and optional HTTP MCP transport                       |
| MCP protocol                                 | Official TypeScript MCP SDK                         | Tools, resources, prompts, and transports                           |
| Static analysis                              | TypeScript Compiler API                             | TypeScript/JavaScript symbols, imports, calls, and source locations |
| Additional language parsing                  | Tree-sitter, as needed                              | Extensible syntax-level support for other languages                 |
| Database access                              | DB0                                                 | Database connection abstraction                                     |
| Initial graph storage                        | SQLite, subject to DB0/Bun compatibility validation | Persist nodes, edges, evidence, and indexing metadata               |
| Dashboard                                    | React + TypeScript                                  | Developer-facing interface                                          |
| Graph visualization                          | React Flow                                          | Interactive nodes, edges, selection, and graph navigation           |
| Unit/integration tests                       | Vitest                                              | Analyzer, graph engine, database, API, and protocol testing         |
| E2E tests                                    | Playwright                                          | Dashboard and end-to-end workflows                                  |
| CI/CD                                        | GitHub Actions                                      | Enforce quality gates and validate releases                         |

### Important implementation notes

- **Vite+ and Bun have distinct roles.** Bun is the runtime and package manager. Vite+ (`vp`) orchestrates the development workflow and build/test commands. Pin tool versions and verify command syntax against the selected Vite+ release.
- Vite+ defaults may use Oxfmt/Oxlint rather than ESLint. Because ESLint is a required quality gate, install and run it explicitly.
- **DB0 is the database access layer, not the graph engine.** Keep graph storage behind a repository interface. Verify the selected DB0 connector's support for Bun, SQLite, transactions, prepared queries, recursive CTEs, and connection shutdown before committing to it.
- The graph core must not depend on MCP, Hono, React, or a particular database driver.
- Use SQLite initially unless compatibility or measured scale justifies another database.

## 3. Core product requirements

- **Agent interoperability:** support MCP-compatible coding agents through the standard protocol, with tested setup instructions for Claude Code, Cursor, VS Code/GitHub Copilot, Windsurf, Cline, and other compatible clients.
- **Repository understanding:** map symbols, imports, calls, API routes, database access, tests, configuration, and service relationships.
- **Change impact analysis:** identify direct and transitive dependencies of a changed symbol, file, API, or database entity.
- **Evidence-backed results:** include source locations, relationship types, and confidence levels; distinguish facts from inferred relationships.
- **Incremental indexing:** refresh affected graph records after file changes and Git commits rather than re-indexing the entire repository every time.
- **Test selection:** identify relevant existing tests and highlight potential coverage gaps.
- **Dashboard:** interactively browse the graph, inspect nodes, filter relationship types, and explore impact analysis.
- **Security:** local-first operation, repository boundary enforcement, safe SQL, resource limits, and read-only behavior by default.
- **Quality:** unit, integration, protocol, E2E, security, and performance tests in CI.

## 4. High-level architecture

```text
Coding agents
  │ MCP tools / resources / prompts
  ▼
MCP adapter ─────────────────────────────────┐
  │                                          │
  ▼                                          ▼
Shared graph core                       Hono API
  ├── Repository indexing                   │
  ├── Symbol search                         ▼
  ├── Impact analysis                  React dashboard
  ├── Test selection                        └── React Flow
  └── Graph traversal
  │
  ├── TypeScript analyzer
  ├── Framework adapters
  ├── Git diff analyzer
  │
  ▼
GraphRepository interface
  │
  ▼
DB0 adapter / database connector
  │
  ▼
SQLite graph storage (initial target)
```

The MCP server and dashboard API must use the same graph services. This avoids inconsistent results and prevents duplicate implementations of impact analysis.

### Design principle

**The graph engine must not depend on MCP.** MCP is an adapter around ordinary TypeScript services. The same core should be reusable by the dashboard, CLI, and future integrations.

## 5. Dependency graph data model

### 5.1 Node types

Start with a small, extensible set:

| Node type            | Example                       |
| -------------------- | ----------------------------- |
| `repository`         | `starter-hono`                |
| `file`               | `src/services/user.ts`        |
| `symbol`             | `UserService.updateUser`      |
| `route`              | `PATCH /users/:id`            |
| `api_operation`      | GraphQL `updateUser` mutation |
| `database_table`     | `users`                       |
| `database_query`     | An update query               |
| `queue`              | `user.updated`                |
| `test`               | `user.service.test.ts`        |
| `frontend_operation` | `updateUserMutation`          |
| `service`            | `user-api`                    |
| `deployment`         | `production-api`              |

Each node should contain a stable ID, repository ID, type, display name, repository-relative location where applicable, metadata, content hash, and indexing metadata.

Symbol identities should derive from repository identity, file path, qualified name, and symbol kind. Do not rely on line numbers alone, because line numbers change during edits. Handle overloaded functions and same-named symbols explicitly.

### 5.2 Edge types

| Relationship             | Direction                          | Meaning                     |
| ------------------------ | ---------------------------------- | --------------------------- |
| `CONTAINS`               | Repository → File                  | File belongs to repository  |
| `DECLARES`               | File → Symbol                      | File defines symbol         |
| `IMPORTS`                | File → File                        | File imports another file   |
| `CALLS`                  | Symbol → Symbol                    | Symbol calls another symbol |
| `EXPOSES`                | Route → Symbol                     | Route invokes a handler     |
| `READS` / `WRITES`       | Symbol → Database entity           | Data access                 |
| `PUBLISHES` / `CONSUMES` | Symbol → Queue/event               | Event flow                  |
| `TESTS`                  | Test → Symbol                      | Test exercises a symbol     |
| `USES_OPERATION`         | Frontend operation → API operation | Client/server relationship  |
| `DEPENDS_ON`             | Component → Component              | Architectural dependency    |

Each edge must record its evidence source and confidence. Static analysis cannot always prove relationships that rely on dynamic SQL, reflection, dependency injection, generated clients, or runtime configuration. Do not present inferred relationships as confirmed facts.

### 5.3 Initial SQLite schema

This schema is a starting point; add versioned migrations and indexing metadata as the project develops.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
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
  repository_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_nodes_repo_type
  ON nodes(repository_id, type);

CREATE INDEX IF NOT EXISTS idx_nodes_file
  ON nodes(repository_id, file_path);

CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name
  ON nodes(repository_id, qualified_name);

CREATE INDEX IF NOT EXISTS idx_edges_source_type
  ON edges(source_id, type);

CREATE INDEX IF NOT EXISTS idx_edges_target_type
  ON edges(target_id, type);
```

Implementation requirements:

- Parameterize dynamic SQL values.
- Use transactions for graph updates.
- Add schema versioning and repository metadata tables.
- Store repository-relative paths, not machine-specific absolute paths, in graph identities.
- Bound recursive traversal depth and result count.
- Keep DB0-specific logic inside the database adapter.
- Validate connector behavior before relying on SQLite-specific features.

## 6. Analysis engine

### 6.1 Indexing pipeline

1. **Discover repository:** find Git root, supported file extensions, package manifests, TypeScript configs, and ignored/generated directories.
2. **Parse source:** extract declarations, exports, imports, calls, type information, and source locations.
3. **Resolve relationships:** connect modules, symbol calls, routes, handlers, tests, database operations, and API operations.
4. **Persist graph:** transactionally upsert nodes and edges; remove stale relationships for re-indexed files.
5. **Analyze impact:** resolve the target symbol, traverse reverse dependencies, categorize results, and rank by evidence.
6. **Return report:** include affected nodes, paths, confidence, relevant tests, and unresolved relationships.

### 6.2 Analyzer interfaces

Implement analyzers as independent modules behind a shared contract:

- `TypeScriptAnalyzer`: primary analyzer using TypeScript compiler semantics.
- `JavaScriptAnalyzer`: compatible JS analysis using shared compiler infrastructure.
- `TreeSitterAnalyzer`: optional syntax extraction for additional languages.
- `FrameworkAnalyzer`: framework-specific route and handler discovery.
- `TestAnalyzer`: identify test files, suites, imports, and symbol references.
- `DatabaseAnalyzer`: detect ORM models, SQL statements, and migration relationships.
- `FrontendAnalyzer`: match API operations to generated clients, GraphQL documents, or configured endpoint mappings.

Analyzers should emit nodes, edges, evidence, and diagnostics. They must report partial coverage instead of silently claiming complete discovery.

### 6.3 Relationship confidence

Classify relationships as:

- **Static:** resolved through compiler or parser information.
- **Inferred:** matched through conventions, names, framework metadata, or configuration.
- **Runtime-observed:** collected through optional test instrumentation or application traces.

Keep confidence semantics consistent across analyzers. A confidence value should not imply a mathematical probability unless it has been calibrated as one.

## 7. MCP server design

Expose a small set of high-value tools rather than one tool for every internal operation.

| Tool                  | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `index_repository`    | Create or refresh the graph                            |
| `search_symbols`      | Find functions, classes, methods, routes, or tables    |
| `get_symbol_details`  | Return definition, references, and direct dependencies |
| `analyze_impact`      | Identify direct and transitive effects of a change     |
| `find_dependents`     | Find reverse dependencies                              |
| `find_dependencies`   | Explore outgoing dependencies                          |
| `find_related_tests`  | Recommend tests associated with a symbol               |
| `analyze_git_diff`    | Identify affected symbols for a Git diff               |
| `get_dependency_path` | Explain how two components connect                     |
| `get_graph_summary`   | Return architecture summary and indexing status        |

### 7.1 Example `analyze_impact` input

```json
{
  "repository": ".",
  "symbol": "UserService.updateUser",
  "maxDepth": 5,
  "includeTests": true,
  "includeIndirectDependencies": true
}
```

### 7.2 Example response

```json
{
  "target": {
    "name": "UserService.updateUser",
    "file": "src/services/user.ts",
    "line": 42
  },
  "affected": [
    {
      "name": "UserController.updateUser",
      "type": "symbol",
      "relationship": "CALLS",
      "confidence": 1.0,
      "evidence": {
        "file": "src/controllers/user.ts",
        "line": 27
      }
    }
  ],
  "summary": {
    "affectedSymbols": 4,
    "affectedTests": 2,
    "unresolvedRelationships": 1
  }
}
```

This is illustrative output, not a claim about the actual contents of `starter-hono`.

Use Zod schemas for input validation, stable error codes, bounded results, and documented tool descriptions. Return structured content where supported and a readable text summary for clients that primarily consume tool text.

### 7.3 MCP resources and prompts

Suggested resources:

- `graph://repository/summary`
- `graph://repository/index-status`
- `graph://repository/components`

Suggested prompts:

- `impact-analysis`: explain the target, trace dependencies, show evidence, and recommend tests.
- `code-review`: review a Git diff using graph relationships and flag likely regressions.

Do not return the entire graph as one huge resource. Use bounded queries and pagination.

## 8. Coding-agent compatibility

Implement MCP once and provide tested setup instructions for each client. MCP compatibility does not guarantee identical configuration syntax, transport support, permissions, or feature availability in every coding agent.

Target clients:

- Claude Code
- Cursor
- VS Code / GitHub Copilot agent modes
- Windsurf
- Cline
- Other compatible MCP clients

### Transport strategy

- **stdio:** primary local transport for coding agents.
- **Streamable HTTP:** optional for shared or remote deployments, protected by authentication and access control.

For stdio, reserve stdout for protocol messages and send logs to stderr.

### Example configuration

Adapt the configuration keys to the specific client. Paths must be real and the server must be built before launch.

```json
{
  "mcpServers": {
    "dependency-graph": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/relic/apps/mcp-server/src/index.ts"],
      "env": {
        "RELIC_REPOSITORY": "/absolute/path/to/starter-hono"
      }
    }
  }
}
```

Validate whether the selected MCP SDK and Bun version work together for the chosen transport. Also test the built production entry point, not just development execution.

Maintain a compatibility matrix that records client version, transport, setup instructions, tool discovery, and smoke-test results. Protocol tests alone cannot prove that every editor's configuration works.

## 9. Dashboard design

The dashboard is a first-class application and uses the same graph services as the MCP server.

### 9.1 Dashboard screens

1. **Architecture graph:** show repositories, files, symbols, APIs, database entities, tests, and service relationships.
2. **Change impact explorer:** select a symbol or enter a method name to see upstream callers, downstream dependencies, tests, and indirect effects.
3. **Repository overview:** show indexed files, symbols, edges, unresolved dependencies, last indexed Git revision, indexing duration, and analysis coverage.
4. **Node inspector:** display source path, line numbers, relationship evidence, connected nodes, and associated tests.
5. **Indexing status:** show progress, failures, last successful index, and re-index actions.

### 9.2 Suggested layout

```text
┌──────────────────────────────────────────────────────────────┐
│ Relic    Repository: starter-hono    Re-index │
├──────────────┬──────────────────────────────┬────────────────┤
│ Explorer     │                              │ Details        │
│              │       Interactive Graph      │                │
│ Search       │                              │ Selected node  │
│ Node types   │    [Controller] ──> [Service] │ Dependencies   │
│ Relationships│          │                   │ Tests          │
│ Impact       │          v                   │ Source evidence│
│ Tests        │       [Database]              │                │
├──────────────┴──────────────────────────────┴────────────────┤
│ Index status · Git revision · Unresolved edges · Duration    │
└──────────────────────────────────────────────────────────────┘
```

This is a proposed wireframe, not a screenshot of an implemented dashboard.

### 9.3 Dashboard interactions

- Click a node to open its detail panel.
- Expand a node to show immediate dependencies.
- Select a method and invoke **Analyze impact**.
- Toggle incoming, outgoing, or transitive edges.
- Filter by tests, APIs, database entities, frontend consumers, directories, and confidence.
- Highlight the shortest known path between selected nodes.
- Navigate from a graph node to its source file and line.
- Export the current view as JSON or SVG.
- Provide loading, indexing, empty, and error states.
- Support large graphs through neighborhood expansion, pagination, and result limits.

Use React Flow for the graph canvas. Render relationships from the actual stored graph; never invent nodes or edges to make the dashboard appear complete.

## 10. Dashboard API

Use Hono for a typed API consumed by the React dashboard. Keep endpoint handlers thin and delegate graph operations to core services.

Suggested endpoints:

| Endpoint                                | Purpose                                    |
| --------------------------------------- | ------------------------------------------ |
| `GET /api/repositories`                 | List configured repositories               |
| `GET /api/repositories/:id/summary`     | Return graph and indexing statistics       |
| `POST /api/repositories/:id/index`      | Start or request indexing                  |
| `GET /api/graph/nodes`                  | Query nodes with filters and pagination    |
| `GET /api/graph/edges`                  | Query edges for a bounded graph view       |
| `GET /api/graph/nodes/:id`              | Retrieve node details                      |
| `GET /api/graph/nodes/:id/neighborhood` | Expand nearby relationships                |
| `POST /api/impact`                      | Run impact analysis                        |
| `GET /api/tests/related`                | Find tests for a symbol or file            |
| `GET /api/index-status`                 | Retrieve indexing progress and diagnostics |

Validate request parameters, cap query sizes, and ensure repository IDs cannot be used to access paths outside configured roots. For local-only use, bind to loopback by default. If exposed remotely, add authentication and authorization.

## 11. DB0 and graph storage

Keep DB0 behind a database adapter:

- `DatabaseClient`: initializes and manages the DB0 connection.
- `GraphRepository`: persists and queries graph nodes and edges.
- `GraphService`: implements graph traversal and impact analysis independently of the database library.
- `Migrations`: creates and upgrades graph tables.
- `DatabaseAdapter`: hides connector-specific initialization and transaction behavior.

Before implementation is finalized, run a small compatibility spike to verify:

1. DB0 connector support for the intended SQLite backend.
2. Bun runtime compatibility.
3. Parameterized/prepared query support.
4. Transactions and rollback behavior.
5. Recursive CTE support.
6. Connection closing and concurrent read/write behavior.
7. Migration strategy and database file permissions.

If DB0 cannot meet a required behavior, isolate the limitation behind the adapter and select a compatible connector. Do not spread DB0-specific assumptions throughout the graph core.

## 12. Incremental indexing and Git integration

### Full indexing

1. Discover supported files.
2. Parse and resolve relationships.
3. Persist the graph transactionally.
4. Record the indexed Git revision and analyzer version.
5. Report parsing failures and unresolved relationships.

### Incremental indexing

1. Detect added, changed, deleted, and renamed files.
2. Re-index changed files.
3. Remove stale nodes and edges for deleted or replaced declarations.
4. Re-resolve imports and symbols affected by changes.
5. Refresh related tests and framework-specific edges.
6. Advance the index revision only after a successful update.

File watchers can improve responsiveness, but Git diff analysis should remain available for explicit change-impact queries. Watchers alone do not reliably represent branch switches, renames, and generated-file changes.

### Git diff impact analysis

For a PR or local diff:

- Read the diff against the chosen base revision.
- Map changed ranges to enclosing symbols.
- Treat removed, renamed, and modified symbols separately.
- Find callers, tests, API contracts, database dependencies, and transitive consumers.
- Deduplicate overlapping results.
- Rank results by relationship strength and evidence.

Do not mark every symbol in a file as directly affected just because one method changed.

## 13. Testing strategy

Use Vitest for unit and integration tests, and Playwright for E2E orchestration. Include real MCP protocol calls in the tests.

### 13.1 Suggested test structure

```text
tests/
├── unit/
│   ├── analyzers/
│   │   ├── typescript-analyzer.test.ts
│   │   └── symbol-resolution.test.ts
│   ├── graph/
│   │   ├── traversal.test.ts
│   │   └── impact-analysis.test.ts
│   ├── indexing/
│   │   └── incremental-indexer.test.ts
│   ├── dashboard/
│   │   ├── graph-canvas.test.tsx
│   │   └── node-inspector.test.tsx
│   └── mcp/
│       └── tool-schemas.test.ts
├── integration/
│   ├── database-store.test.ts
│   ├── repository-indexing.test.ts
│   ├── git-diff.test.ts
│   ├── dashboard-api.test.ts
│   └── mcp-stdio.test.ts
├── e2e/
│   ├── index-and-analyze.spec.ts
│   ├── dashboard-graph.spec.ts
│   ├── changed-method-impact.spec.ts
│   └── error-recovery.spec.ts
├── security/
│   ├── repository-paths.test.ts
│   └── unsafe-inputs.test.ts
└── fixtures/
    ├── starter-hono/
    ├── graphql-app/
    ├── websocket-app/
    └── monorepo/
```

### 13.2 Critical fixture scenario

Create or adapt a fixture containing:

`UserController → UserService.updateUser → UserRepository.update`

Include a GraphQL resolver, WebSocket action, two unit tests, an integration test, and a frontend mutation.

E2E scenario:

1. Launch the server with a temporary database.
2. Index the fixture.
3. Call `analyze_impact` for `UserService.updateUser`.
4. Verify the controller and repository relationships.
5. Verify known tests and modeled GraphQL/WebSocket consumers appear.
6. Verify unrelated symbols are excluded.
7. Modify a call site and re-index.
8. Confirm stale edges disappear and new edges appear.
9. Delete a source file and verify its graph records are removed.
10. Force an indexing failure and verify there is no partially committed graph update.
11. Open the dashboard and verify it shows the same relationships as the MCP response.
12. Select the changed method and verify the inspector displays source evidence.

For frontend-to-backend matching, use explicit operation metadata or a known endpoint mapping in the fixture. Do not assume every connection can be inferred automatically.

### 13.3 Coverage targets

Suggested initial thresholds for production code:

| Metric     | Target |
| ---------- | -----: |
| Statements |    85% |
| Branches   |    80% |
| Functions  |    85% |
| Lines      |    85% |

Configure coverage thresholds in Vitest. Exclude generated code, fixtures, and test utilities appropriately. Give extra attention to branch coverage in graph traversal, symbol resolution, and incremental indexing. Add mutation testing for critical graph algorithms once the baseline suite is stable.

## 14. Quality gates with Vite+ and Bun

The required order is:

1. Format check
2. ESLint
3. TypeScript checks
4. Unit tests with coverage
5. Integration tests
6. Production build
7. Playwright E2E and MCP protocol tests
8. Security checks

Use Vite+ (`vp`) to orchestrate the workflow and Bun for runtime/package management. Vite+ defaults may use Oxfmt/Oxlint, so configure the required formatter and ESLint explicitly. Avoid running duplicate static checks unnecessarily.

Suggested scripts (verify the exact `vp` commands against the installed Vite+ version):

```json
{
  "scripts": {
    "format:check": "vp fmt --check",
    "lint": "eslint . --max-warnings=0",
    "typecheck": "vp check --no-fmt --no-lint",
    "test:unit": "vp test",
    "test:integration": "vp run test:integration",
    "test:coverage": "vp test --coverage",
    "build": "vp build",
    "test:e2e": "playwright test",
    "security": "vp run security",
    "ci": "vp run format:check && vp run lint && vp run typecheck && vp run test:coverage && vp run test:integration && vp run build && vp run test:e2e && vp run security"
  }
}
```

Treat these as proposed script names, not a guarantee that every command is built into every Vite+ release. Define project tasks in the Vite+ configuration as required. Keep E2E tests against the built server rather than only a development runner.

GitHub Actions should run the same gates as local development, use pinned tool versions, install dependencies reproducibly from the Bun lockfile, and cache dependencies where appropriate. Run security and performance checks as separate jobs when practical.

## 15. Recommended monorepo structure

```text
relic/
├── apps/
│   ├── mcp-server/
│   │   └── src/
│   │       ├── transports/
│   │       ├── tools/
│   │       ├── resources/
│   │       ├── prompts/
│   │       └── index.ts
│   ├── dashboard/
│   │   └── src/
│   │       ├── components/
│   │       │   ├── graph/
│   │       │   ├── inspector/
│   │       │   └── layout/
│   │       ├── pages/
│   │       └── api/
│   └── api/
│       └── src/
│           ├── routes/
│           └── index.ts
├── packages/
│   ├── graph-core/
│   │   ├── domain/
│   │   ├── graph/
│   │   ├── impact/
│   │   └── errors/
│   ├── analyzer-typescript/
│   ├── analyzer-treesitter/
│   ├── framework-adapters/
│   │   ├── hono/
│   │   ├── graphql/
│   │   └── websocket/
│   ├── database/
│   │   ├── db0-client.ts
│   │   ├── migrations/
│   │   └── graph-repository.ts
│   ├── contracts/
│   └── test-utils/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   ├── security/
│   └── fixtures/
├── examples/
│   └── starter-hono/
├── docs/
│   ├── architecture.md
│   ├── dashboard.md
│   ├── graph-schema.md
│   ├── supported-agents.md
│   └── adding-an-analyzer.md
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── security.yml
│       └── performance.yml
├── package.json
├── bun.lock
├── tsconfig.json
└── vite.config.ts
```

Keep dependency direction one-way: analyzers emit graph data, storage persists it, core services query it, and MCP/API adapters expose it.

## 16. Security and operational requirements

- **Repository boundaries:** index only configured repository roots. Canonicalize paths and reject traversal outside allowed roots.
- **Symlinks:** verify resolved paths cannot escape the repository.
- **Read-only by default:** graph analysis must not modify source files or execute repository scripts.
- **Command execution:** never interpolate tool arguments into shell commands; use safe argument-based process execution for Git.
- **Resource limits:** bound file sizes, traversal depth, result counts, parser duration, and indexing concurrency.
- **SQL safety:** use parameterized queries and bounded recursive traversals.
- **Privacy:** keep source code and graph data local by default. Do not send source contents to external model APIs.
- **Remote transport:** require authentication, authorization, and encrypted transport.
- **Error handling:** avoid leaking secrets, environment variables, or sensitive absolute paths.
- **Cancellation:** propagate cancellation through indexing and graph queries where supported.
- **Untrusted source:** repository files and configuration must never be allowed to change the server's security policy.

## 17. Development roadmap

### Phase 1 — Foundation

- Create Bun workspace and Vite+ configuration.
- Configure strict TypeScript, ESLint, formatting, and CI.
- Add database abstraction, DB0 compatibility spike, migrations, and graph domain types.
- **Exit criterion:** build and test the base project reproducibly.

### Phase 2 — Graph engine

- Implement TypeScript indexing and symbol resolution.
- Persist graph nodes and edges.
- Add direct and transitive impact analysis.
- **Exit criterion:** answer the `updateUser()` question accurately on a deterministic fixture.

### Phase 3 — MCP server

- Implement tools, resources, prompts, stdio transport, and input validation.
- Add protocol integration tests.
- **Exit criterion:** a generic MCP client can index a repository and retrieve an impact report.

### Phase 4 — Dashboard MVP

- Implement React Flow canvas, search, node inspector, filters, repository overview, and indexing status.
- Connect the dashboard to the Hono API and shared graph services.
- **Exit criterion:** a developer can explore the actual graph and inspect relationships.

### Phase 5 — Reference repository and framework adapters

- Index `starter-hono`.
- Discover Hono routes, handlers, tests, and relevant database relationships where present.
- Add GraphQL, WebSocket, and frontend adapters through fixtures.
- **Exit criterion:** modeled dependencies appear consistently in MCP responses and the dashboard.

### Phase 6 — Reliability and release

- Implement incremental indexing and Git diff analysis.
- Complete E2E, security, coverage, and performance gates.
- Validate client-specific MCP setup instructions.
- Document limitations, installation, troubleshooting, and releases.
- **Exit criterion:** clean installation, reproducible build, green CI, and verified client smoke tests.

Do not begin with many language or framework adapters before the core graph and impact analysis are trustworthy.

## 18. First-release definition of done

- [ ] Indexes a TypeScript repository from scratch.
- [ ] Resolves imports and statically identifiable function calls.
- [ ] Stores nodes and edges through the database abstraction.
- [ ] Supports direct and transitive impact analysis.
- [ ] Returns source locations and relationship evidence.
- [ ] Identifies relevant unit and integration tests.
- [ ] Exposes validated MCP tools, resources, and prompts.
- [ ] Works with a generic MCP client over stdio.
- [ ] Provides a working dashboard with graph search, filters, node inspection, and impact analysis.
- [ ] Shows consistent graph relationships in the dashboard and MCP responses.
- [ ] Includes unit, integration, protocol, and E2E tests.
- [ ] Enforces formatting, ESLint, TypeScript, coverage, build, and security gates.
- [ ] Handles file deletion, renames, and incremental re-indexing.
- [ ] Provides setup documentation and security safeguards.

## 19. Final recommendation

Build a **Bun-powered, Vite+-managed TypeScript monorepo** with:

- A shared dependency graph core.
- A standards-based MCP server for coding agents.
- A Hono API for the dashboard.
- A React + React Flow interactive graph dashboard.
- DB0 behind a database repository interface, with SQLite as the initial graph store after compatibility validation.
- `starter-hono` as the first real-world indexing target.
- Vitest, Playwright, protocol, security, and performance testing.
- GitHub Actions enforcing the complete quality-gate pipeline.

The most important engineering challenge is not storing a graph; it is building a **trustworthy graph**. The first release should resolve TypeScript symbols accurately, distinguish direct from inferred dependencies, explain why a node is affected, and avoid reporting unsupported relationships as facts. Once those capabilities are stable, the MCP interface and dashboard provide two complementary ways to use the same repository intelligence.
