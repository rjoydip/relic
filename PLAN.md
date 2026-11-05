# Relic — Plan

**Status:** 2026-11-05. First release and roadmap items 19.0–19.3 are complete.
Remaining work is the 19.4 "bigger bets" list at the end of this document.

## Product

Relic is a static dependency-graph engine for TypeScript/JavaScript repositories.
It indexes symbols, files, routes, tests, SQL tables, and their relationships, then
exposes the same graph through:

- an MCP stdio server for coding agents,
- a local Hono HTTP API,
- a React Flow dashboard,
- a `relic` CLI for indexing, CI, export, and PR reports.

The promise is evidence, not guesses: every edge carries a source `file:line`,
a confidence (`static` 1.0 / `runtime` 0.9 / `inferred` 0.6), and a note when the
relationship was inferred. Unresolved relationships become diagnostics; they are
never invented edges.

## Architecture

| Package                        | Responsibility                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `packages/graph-core`          | Domain types, `GraphRepository` contract, `GraphService` (traversal, impact, analytics, risk) |
| `packages/database`            | SQLite storage (`node:sqlite`) behind `GraphRepository`, recursive-CTE traversal              |
| `packages/analyzer-typescript` | Two-pass TypeScript analyzer: extract declarations/imports/calls, then resolve relationships  |
| `packages/indexer`             | Incremental indexing, change detection, owner metadata, git-diff helpers                      |
| `apps/mcp-server`              | MCP tools, resources, prompts over stdio                                                      |
| `apps/api`                     | Hono API, publishable `relic` / `relic-mcp` package, CLI, dashboard host                      |
| `apps/dashboard`               | React + React Flow explorer                                                                   |

**Data flow:** walk repository → extract per file → resolve cross-file edges →
persist transactionally → query through `GraphService` → MCP / HTTP / CLI / dashboard.

**Invariants**

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

- [x] Indexes TypeScript repositories incrementally (delete/rename handled as remove + add).
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

## Next: 19.4 bigger bets

| Feature                            | Acceptance                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Second language analyzer           | A Python analyzer behind the same contract; fixture parity on symbols, calls, tests, and routes; no graph-core changes.              |
| Queue / service / deployment nodes | Publish/subscribe calls, service manifests, and Docker/K8s references become nodes and edges with evidence.                          |
| Runtime evidence                   | lcov or OpenTelemetry ingest upgrades `TESTS`/`CALLS` edges to `runtime`; conflicts with static edges are reported, not overwritten. |
| Cross-repo / monorepo graph        | Workspace sibling imports link to nodes in another indexed repository; impact traverses the boundary.                                |
| Semantic search                    | Natural-language query returns ranked symbols with evidence; falls back to keyword search without an index.                          |

## Sequencing

1. Ship 19.0–19.3 (done).
2. Add 19.4 capabilities only when a real repository or language demands them.
3. Keep the quality gates and evidence model intact as analyzers and sources grow.

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
