# Relic — Plan

**Status:** 2026-11-06. First release, roadmap items 19.0–19.5 are complete.

## Product

Relic is a static dependency-graph engine for TypeScript/JavaScript, Python,
Rust, Java and Go repositories, plus the service/deployment manifests around
them. It indexes symbols, files, routes, tests, SQL tables, queues, services,
deployments, and their relationships, then exposes the same graph through:

- an MCP stdio server for coding agents,
- a local Hono HTTP API,
- a React Flow dashboard,
- a `relic` CLI for indexing, CI, export, runtime evidence, and PR reports.

The promise is evidence, not guesses: every edge carries a source `file:line`,
a confidence (`static` 1.0 / `runtime` 0.9 / `inferred` 0.6), and a note when the
relationship was inferred. Unresolved relationships become diagnostics; they are
never invented edges.

## Architecture

| Package                        | Responsibility                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `packages/core`                | Domain types, `GraphRepository` contract, `GraphService` (traversal, impact, analytics, risk) |
| `packages/database`            | SQLite storage (`node:sqlite`) behind `GraphRepository`, recursive-CTE traversal              |
| `packages/analyzer/core`       | Shared contract, discovery, resolver, manifests, owners                                       |
| `packages/analyzer/typescript` | TypeScript/JavaScript analyzer                                                                |
| `packages/analyzer/python`     | Python analyzer                                                                               |
| `packages/analyzer/rust`       | Rust analyzer                                                                                 |
| `packages/analyzer/java`       | Java analyzer                                                                                 |
| `packages/analyzer/go`         | Go analyzer                                                                                   |
| `packages/indexer`             | Incremental indexing, change detection, owner metadata, git-diff helpers                      |
| `apps/mcp`                     | MCP tools, resources, prompts over stdio                                                      |
| `apps/api`                     | Hono API, publishable `relic` / `relic-mcp` package, CLI, dashboard host                      |
| `apps/dashboard`               | React + React Flow explorer                                                                   |

**Data flow:** walk repository → extract per file → resolve cross-file edges →
persist transactionally → query through `GraphService` → MCP / HTTP / CLI / dashboard.

### Invariants

- Node identity derives from repository + path + qualified name, not line numbers.
- Edges are only emitted when a target resolves; unresolved targets are diagnostics.
- Static facts outrank inferred relationships; the dashboard and MCP expose both.
- Indexing never executes repository code.
- The graph DB is shared by MCP, API, CLI, and dashboard.

## Quality gates

```sh
bun run ci   # format:check, lint, coverage tests, security suite, build
bun run test:e2e
```

- TypeScript across three projects, `oxlint --deny-warnings`, `oxfmt --check`.
- Unit, integration, protocol (MCP stdio), security, and Playwright E2E suites.
- CI runs the E2E suite as a separate step after `bun run ci`.
- No secrets, path traversal, shell interpolation, or source uploads in CI actions.

## Definition of done (first release)

- [x] Indexes TypeScript/JavaScript, Python, Rust, Java and Go repositories incrementally (delete/rename handled as remove + add).
- [x] Resolves relative imports, tsconfig `paths`/`baseUrl` aliases, and workspace packages.
- [x] Resolves statically identifiable calls, routes, GraphQL/WebSocket operations, SQL, and tests.
- [x] Stores nodes/edges through `GraphRepository` with evidence and confidence.
- [x] Supports direct and transitive impact analysis with upstream/downstream direction.
- [x] Identifies relevant tests and returns source locations.
- [x] Exposes validated MCP tools, resources, and prompts over stdio.
- [x] Ships a dashboard with search, filters, inspection, impact, cycles, owners, and diagnostics.
- [x] Provides a `relic` CLI for index/serve/watch/impact/export/check/init/pr/diff.
- [x] Handles deletion, renames, and incremental re-indexing.
- [x] Documents setup, security limits, and the agent skill.

## Completed roadmap

### 19.0 — First-release gaps

Dashboard impact mode with evidence/confidence and tests/indirect toggles;
diagnostics drawer with `file:line` jumps; E2E and security wired into CI.

### 19.1 — Correctness

tsconfig path/workspace import resolution with diagnostics for unknown aliases;
`findDependents`/`findDependencies` return `TraversalStep[]` with evidence; bounded
source excerpts in `get_symbol_details`; framework routes for Next.js App/Pages,
NestJS decorators, Express/Fastify, and tRPC.

### 19.2 — Graph analytics

Cycle detection (`find_cycles`, dashboard highlight), opt-in dead-code query,
coupling metrics (fan-in/fan-out/instability), deterministic impact risk score
with factor breakdown, snapshot diff (`relic diff --check`), and CODEOWNERS +
git-blame ownership (`get_owners`).

### 19.3 — Automation and distribution

`relic --watch` with incremental re-indexing and SSE updates; `relic check`
boundary rules; `relic impact`; `relic export` (Mermaid/DOT); `relic init`
(idempotent MCP config + skill); `relic pr` and the `.github/actions/relic-pr`
composite action for PR comments. Branch switches still require an explicit
re-index.

### 19.4 — Bigger bets

- **Python analyzer** behind the shared `extractSourceFile` contract: symbols,
  class-qualified names, imports, calls, Flask/FastAPI/Django routes, SQL, tests,
  and pub/sub calls. Covered by a fixture and indexed end-to-end.
- **Queue / service / deployment nodes** from pub/sub calls plus docker-compose,
  Dockerfile, and Kubernetes manifests, linked with `PUBLISHES`/`CONSUMES` and
  `DEPENDS_ON` edges.
- **Runtime evidence** ingest from lcov or OTLP JSON. `CALLS`/`TESTS` edges are
  upgraded to `runtime` confidence; static conflicts become `runtime-conflict`
  diagnostics and are never overwritten. Available through the API, MCP, and
  `relic runtime`.
- **Cross-repo / monorepo graph**: workspace sibling imports resolve to nodes in
  another indexed repository, and the database validates edges against all known
  nodes so impact traverses repository boundaries.
- **Semantic search**: deterministic local lexical BM25 ranking
  (`search_semantic`, `GET /api/search`) with keyword fallback when no index or
  no ranked hits exist.

### 19.5 — Polyglot analyzer packages

- `analyzer-core` owns discovery, the extracted-file contract, resolution, manifests and owners.
- One package per language: `analyzer-typescript`, `analyzer-python`, `analyzer-rust`,
  `analyzer-java`, `analyzer-go`; the indexer dispatches by extension.
- Rust/Java/Go share a regex-driven brace-language engine for symbols, imports,
  calls, SQL, queues, tests, and actix/axum, Spring, Gin and net/http routes.

## Non-goals and constraints

- No code execution during indexing; the analyzer only reads source.
- No ML or hosted service in the core; analytics are deterministic and local.
- DB0 was evaluated away; SQLite via `GraphRepository` is the storage boundary.
- Dead-code detection is a heuristic, not a required gate.
- GitHub PR comments run only for same-repository PRs (fork tokens are read-only).

## References

- `docs/index.md` — usage, HTTP API, graph model, indexing semantics, security limits.
- `README.md` — install, MCP config, CLI quickstart, deployment.
- `skills/relic/SKILL.md` — agent query order and reporting rules.
