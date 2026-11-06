# Relic

Static dependency-graph engine for TypeScript/JavaScript, Python, Rust, Java and Go repositories. Relic parses
your source, reads service/deployment manifests, stores the result in a local SQLite database, and exposes it
three ways: an MCP server for coding agents, a CLI + HTTP API, and a React Flow dashboard.

Everything runs locally. No account, no hosted service, no source code leaves the machine — the only network
access is an optional `git clone` when you ask it to index a GitHub URL.

## What Relic is

Ask "what breaks if I change `UserService.updateUser`?" and get an evidence-backed list: every edge carries a
source file, line, confidence (`static` 1.0 vs `inferred` 0.6), and a note explaining how it was resolved.
Calls that cannot be resolved become diagnostics; they never become invented edges.

- **MCP server** — 15 tools, 3 resources and 2 prompts over stdio, for Claude Code, Cursor, Cline, Windsurf,
  or any MCP client.
- **CLI** — `relic` indexes a project, serves the API + dashboard, and opens a browser. `relic index` is the
  headless variant for scripts and CI; `relic diff a.json b.json --check` fails on snapshot drift.
- **Dashboard** — React + React Flow explorer with node search, neighbourhood expansion, code peek,
  impact analysis (risk score, coupling, owners) and cycle highlighting.
- **Library** — `graph-core` (domain + traversal + impact), `database` (SQLite repository), `analyzer-core`
  (shared contract + resolver), per-language analyzers (`analyzer-typescript`, `analyzer-python`,
  `analyzer-rust`, `analyzer-java`, `analyzer-go`), `indexer` (incremental orchestration, manifests,
  runtime evidence).

Relic supports TypeScript/JavaScript, Python, Rust, Java and Go today. The analyzer never executes indexed
code — it only reads it.

## Requirements

| Requirement | Why                                                         |
| ----------- | ----------------------------------------------------------- |
| Node ≥ 23.4 | `node:sqlite`, used by `packages/database`                  |
| bun 1.4+    | Workspace scripts, tests, and the dev servers               |
| git         | Optional — revision tracking and GitHub URL cloning/refresh |

## Install from source

Relic is not published to npm yet. Everything below assumes a checkout of
[github.com/rjoydip/relic](https://github.com/rjoydip/relic).

```sh
bun install
bun run build
```

`bun run build` type-checks the three TS projects, builds the dashboard with Vite, then bundles
`apps/api/dist/cli.js` and `apps/api/dist/index.js` (dashboard assets land in `apps/api/dist/dashboard`).

Run the CLI straight from the bundle, or from source during development:

```sh
node apps/api/dist/cli.js            # serve the project in the current directory
node apps/api/dist/index.js          # MCP stdio server

bun run apps/api/src/cli.ts          # same, no build needed (dashboard needs a Vite build)
bun run apps/mcp/src/index.ts
```

## MCP server

The server auto-indexes its launch directory on startup, so tools answer immediately. stdout is reserved for
protocol messages; all logs go to stderr.

```json
{
  "mcpServers": {
    "relic": {
      "command": "node",
      "args": ["/absolute/path/to/relic/apps/api/dist/index.js"],
      "env": { "RELIC_REPOSITORY": "/absolute/path/to/your/repo" }
    }
  }
}
```

Point `args` at `/absolute/path/to/relic/apps/mcp/src/index.ts` with `"command": "bun"` if you have not
built the bundle.

### Environment

| Variable           | Default                   | Effect                                            |
| ------------------ | ------------------------- | ------------------------------------------------- |
| `RELIC_REPOSITORY` | —                         | Default repository for tool calls (path or id)    |
| `RELIC_ROOT`       | `RELIC_REPOSITORY` or cwd | Project auto-indexed at startup                   |
| `RELIC_DB`         | `<tmpdir>/relic.db`       | Graph SQLite file (shared with the CLI/dashboard) |

### Tools

| Tool                  | Inputs                                                                                      | Returns                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `index_repository`    | `repository?`, `revision?`                                                                  | `IndexResult` (counts, duration, diagnostics)                              |
| `search_symbols`      | `query`, `type?`, `repository?`                                                             | Matching nodes + count                                                     |
| `get_symbol_details`  | `nodeId?` or `symbol?`, `repository?`                                                       | Definition, incoming/outgoing edges with evidence, ≤80-line source excerpt |
| `analyze_impact`      | `nodeId?` or `symbol?`, `maxDepth?` (1–10), `includeTests?`, `includeIndirectDependencies?` | Affected nodes with relationship, depth, confidence, evidence              |
| `find_dependents`     | `nodeId?` or `symbol?`, `maxDepth?` (default 3)                                             | Reverse traversal steps: node, edge, depth, evidence                       |
| `find_dependencies`   | `nodeId?` or `symbol?`, `maxDepth?` (default 3)                                             | Forward traversal steps: node, edge, depth, evidence                       |
| `find_related_tests`  | `nodeId?` or `symbol?`, `repository?`                                                       | Tests linked by `TESTS` edges + one hop back                               |
| `find_cycles`         | `repository?`                                                                               | SCCs (size ≥ 2) with nodes and internal edges over `IMPORTS`/`CALLS`       |
| `find_dead_code`      | `repository?`, `includeTests?`                                                              | Exported symbols with zero incoming usage edges (opt-in heuristic)         |
| `get_owners`          | `nodeId?` or `symbol?`, `repository?`                                                       | CODEOWNERS owners plus a git-blame author summary                          |
| `analyze_git_diff`    | `base?` (default `HEAD`), `head?` (default working tree), `maxDepth?`                       | Changed files, changed targets, transitive impact                          |
| `get_dependency_path` | `from`, `to`, `repository?`                                                                 | Shortest known relationship path                                           |
| `search_semantic`     | `query`, `repository?`, `limit?` (1–100)                                                    | Ranked nodes with score + evidence, keyword fallback                       |
| `ingest_runtime`      | `format` (`lcov` or `otel`), `content`, `repository?`                                       | Observations, upgraded/conflict/unmatched counts, diagnostics              |
| `get_graph_summary`   | `repository?`                                                                               | Repository meta, counts, diagnostics, coupling report                      |

Symbols resolve by exact name or qualified name; an ambiguous name fails with the first five matches and asks
for `nodeId`. Errors are returned as `ERROR [CODE]: message` with `isError: true`.

### Resources and prompts

- `graph://repository/summary` — graph and indexing statistics
- `graph://repository/index-status` — revision, duration, file count, diagnostics
- `graph://repository/components` — bounded list of indexed components
- Prompt `impact-analysis` (`symbol`) — trace impact, routes, tables and tests, flag inferred edges
- Prompt `code-review` (`summary`) — review a change using `analyze_git_diff`

## CLI

```sh
relic                          # index cwd, serve API + UI, open the browser
relic /path/to/repo            # index a specific project
relic --port 9000 --no-open    # --port, --db, --no-open, --watch
relic index /path/to/repo      # one-shot: index, print IndexResult JSON on
                               # stdout, exit non-zero on failure
relic impact <symbol> --json   # blast radius + deterministic risk score
relic export --format mermaid  # mermaid | dot
relic check                    # architecture boundary rules, exit 1 on violation
relic init                     # merge .mcp.json + write skills/relic/SKILL.md
relic pr --base origin/main    # Markdown impact report for a pull request
relic diff a.json b.json --check
relic runtime coverage.lcov    # upgrade CALLS/TESTS edges from lcov or OTLP JSON
```

- Server binds `127.0.0.1` only; `--no-open` skips launching the browser.
- Port: `--port`, else `PORT`, else `8787`.
- Database: `--db`, else `RELIC_DB`, else `<tmpdir>/relic.db`. The MCP server, CLI, API and dashboard share it.
- `relic index` writes JSON to stdout and logs to stderr, which is what agents and CI consume.
- `--watch` re-indexes incrementally on changes and pushes `graph-updated` SSE events. Branch switches are not detected — run `relic index` after a checkout.
- `relic runtime <file>` re-indexes first, then upgrades matching `CALLS`/`TESTS` edges. `--runtime-format lcov|otel`
  overrides format detection; `--json` prints the `RuntimeReport`. Static conflicts become `runtime-conflict`
  diagnostics.

### Boundary rules

`relic check` reads `.relicrc.json` (or `relic.config.json`, or `--config <file>`):

```json
{
  "boundaries": [
    { "from": "src/ui/**", "to": "src/database/**", "message": "UI must not import database" }
  ]
}
```

Rules match importer/imported repo-relative paths (`*`, `**`, `?`) and default to `IMPORTS`; set
`"edgeTypes": ["CALLS"]` to check calls instead. Violations print the offending files and evidence, and the
command exits 1.

### Pull request comments

`.github/actions/relic-pr` runs `relic pr`, then posts the Markdown report with `gh pr comment`. It needs
`fetch-depth: 0`, `contents: read`, and `pull-requests: write`. Only symbol names, paths, test names, and
evidence locations are sent — no source text.

## HTTP API

All routes are under `/api`. `repository` accepts either a repository id or a filesystem path.

| Method | Path                                | Notes                                                                                           |
| ------ | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/repositories`                     | All indexed repositories with metadata                                                          |
| GET    | `/repositories/:id/summary`         | Repository meta + node/edge counts                                                              |
| POST   | `/repositories/:id/index`           | Re-index; body `{ "root": "/path" }` optional                                                   |
| GET    | `/repositories/:id/file?path=`      | File contents for the dashboard peek (path must stay in the repo)                               |
| POST   | `/index`                            | Body `{ "source": "/path" }` or `{ "source": "https://github.com/o/r" }`                        |
| GET    | `/index-status?repository=`         | Revision, timestamps, counts, diagnostics                                                       |
| GET    | `/graph/nodes`                      | `repository`, `type`, `filePath`, `q`, `limit` (default 50), `offset`                           |
| GET    | `/graph/edges`                      | `repository`, `sourceId`, `targetId`, `types` (CSV), `limit` (default 200)                      |
| GET    | `/graph/nodes/:id`                  | Single node                                                                                     |
| GET    | `/graph/nodes/:id/neighborhood`     | `depth` (1–4, default 1), `limit`; forward + reverse traversal                                  |
| POST   | `/impact`                           | Body `{ repository, nodeId \| symbol, maxDepth?, includeTests?, includeIndirectDependencies? }` |
| GET    | `/cycles?repository=`               | Strongly connected components over `IMPORTS`/`CALLS`                                            |
| GET    | `/search?repository=&q=&limit=`     | Ranked semantic/lexical search with keyword fallback                                            |
| POST   | `/repositories/:id/runtime`         | Body `{ "format": "lcov" \| "otel", "content": "…" }`; upgrades runtime evidence                |
| GET    | `/events`                           | SSE stream: `graph-updated` after every index/re-index                                          |
| GET    | `/tests/related?repository=&nodeId= | symbol=`                                                                                        | Tests linked to a node |

Pagination is capped at 5000 rows. Errors come back as `{ "error": "<CODE>", "message": "…" }` with `400`
for input problems and `404` for `REPOSITORY_NOT_FOUND` / `NODE_NOT_FOUND`. Codes: `INVALID_INPUT`,
`REPOSITORY_NOT_FOUND`, `NODE_NOT_FOUND`, `PATH_ESCAPE`, `INTERNAL`.

GitHub sources are shallow-cloned into `<tmpdir>/relic-github/<hash>` and `git pull --ff-only` on re-index;
they are rejected when the API is configured with `allowedRoots`.

## Dashboard

```sh
bun run dev            # starts API :8787, dashboard :5173, docs :5174
```

The dashboard proxies `/api` to the API and `/docs/` to the docs server, so
`http://127.0.0.1:5173/docs/` works in dev. `bun run build` also builds the docs
into the dashboard output, and `relic` serves them at `/docs/`.

The UI supports searching nodes, expanding a neighbourhood, poking at source code, and running impact
analysis. Its index bar accepts a local path or a GitHub URL.

## Graph model

Node types: `repository`, `file`, `symbol`, `route`, `api_operation`, `database_table`, `database_query`,
`queue`, `test`, `frontend_operation`, `service`, `deployment`.

Edge types: `CONTAINS`, `DECLARES`, `IMPORTS`, `CALLS`, `EXPOSES`, `READS`, `WRITES`, `PUBLISHES`, `CONSUMES`,
`TESTS`, `USES_OPERATION`, `DEPENDS_ON`.

Every edge stores confidence derived from its evidence source:

| Evidence  | Confidence | Meaning                                                                       |
| --------- | ---------- | ----------------------------------------------------------------------------- |
| `static`  | 1.0        | Exact declaration/import/call resolution from the AST                         |
| `runtime` | 0.9        | Observed in lcov/OTLP runtime evidence (upgrades static `CALLS`/`TESTS`)      |
| inferred  | 0.6        | Convention-based (e.g. property call via an import binding, endpoint mapping) |

Diagnostics (`unresolved`, `parse-error`, `skipped`, `runtime-conflict`) are stored on the repository and
surfaced by `index-status` and `get_graph_summary`. Unresolved references are never persisted as edges, and
runtime evidence never deletes a static edge.

## Indexing semantics

- **Files:** `.ts .tsx .mts .cts .js .jsx .mjs .cjs .py .rs .java .go`, plus `Dockerfile*`, `*.dockerfile`,
  `docker-compose*.yml/yaml`, and any YAML containing `apiVersion` + `kind`. Hidden entries and
  `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `out`, `.data` are skipped.
- **Incremental:** files are compared by content hash. Changed files, deleted files, and the _importers_ of
  changed/deleted files are re-analyzed so `IMPORTS` edges re-resolve. Runtime-upgraded edges survive
  re-indexing.
- **Two passes:** pass A extracts declarations, imports, calls, routes, SQL, pub/sub calls and frontend
  operations; pass B resolves relationships against fresh declarations plus the database.
- **Extraction:** functions, classes, methods and variables become `symbol` nodes; route handlers
  (`get/post/put/patch/delete/head/options` with a `/`-prefixed path) become `route` nodes; `on` handlers
  become `api_operation`; SQL strings produce `READS`/`WRITES` edges to `database_table` nodes; test files
  (`.test`/`.spec`, `test_*.py`/`*_test.py`, `*_test.go`, `*Test.java`, Rust `tests/`, or anything under
  `tests/`, `__tests__/`) become `test` nodes with `TESTS` edges.
- **Python:** module/class/function symbols, `from`/`import` bindings, statically named calls, Flask/FastAPI/
  Django routes, SQL strings, tests, and broker publish/subscribe calls follow the same contract as TypeScript.
- **Rust, Java, Go:** module imports (`use crate::…`, `import a.b.C;`, `import "pkg"`), type/class/struct
  containers, methods, calls, SQL, queues, tests, and common framework routes (actix/axum, Spring, Gin/net/http).
  The per-language packages live under `packages/analyzer/*`; `analyzer-core` owns the shared contract.
- **Queues and manifests:** publish/subscribe calls create `queue` nodes with `PUBLISHES`/`CONSUMES` edges;
  compose services, Dockerfiles, and Kubernetes workloads create `service`/`deployment` nodes and
  `DEPENDS_ON` edges.
- **Monorepos:** a workspace sibling import (for example `@cross/lib`) links to nodes in another indexed
  repository, and impact traversal crosses that boundary.
- **Atomic:** the graph for a repository is replaced transactionally; deleted files and orphaned tables and
  queues are pruned. Edges whose endpoints are missing are dropped and reported as diagnostics.
- **Revision:** `git rev-parse HEAD` is recorded automatically unless `revision` is passed to
  `index_repository`.

## Security & limits

- The server binds `127.0.0.1` and is meant for local use; it has no authentication.
- Repository paths and file peeks are checked against the repository root (`PATH_ESCAPE`); when
  `allowedRoots` is configured, repository paths must resolve inside them.
- SQL is fully parameterized (see `tests/security/`), pagination is capped, and indexed code is never executed.
- GitHub clones are shallow (`--depth 1`) with a timeout and no size cap — expose that endpoint beyond
  localhost only after adding one.

## Repository layout

```sh
packages/
  core/                   domain types, GraphRepository interface, GraphService (impact analysis)
  database/               node:sqlite storage behind GraphRepository (recursive-CTE traversal)
  analyzer/
    core/                 shared analyzer contract, discovery, resolver, manifests, owners
    typescript/           TypeScript/JavaScript analyzer
    python/               Python analyzer
    rust/                 Rust analyzer
    java/                 Java analyzer
    go/                   Go analyzer
  indexer/                incremental indexing (hash change detection, importer re-expansion), runtime evidence
apps/
  mcp/                    MCP stdio server: 15 tools, 3 resources, 2 prompts
  api/                    Hono API + the publishable package: `relic` CLI and `relic-mcp` bins
  dashboard/              React + React Flow graph explorer
tests/
  fixtures/analyzer/typescript/  deterministic fixture (UserController → UserService.updateUser → UserRepository.update)
  fixtures/analyzer/{python,go,java,rust}/  per-language analyzer fixtures
  fixtures/{cross-repo,infra}/   workspace and deployment scenarios
  unit|integration|security/
```

## Development

```sh
bun run typecheck   # tsc (3 projects)
bun run lint        # oxlint --deny-warnings
bun run test        # bun test
bun run test:e2e    # playwright (isolated API port + temp DB)
bun run build       # tsc + vite dashboard + docs + esbuild bundles in apps/api/dist
bun run ci          # format:check + lint + typecheck + test:coverage + build
```

Pull requests are expected to pass format, lint, type-check, unit tests with coverage and a full build.

## License

No license file is declared in this repository yet. Treat the code as all rights reserved until one is added.
