# MCP Dependency Graph

Static dependency-graph engine for TypeScript repositories, exposed three ways: an MCP server (for coding agents), a Hono HTTP API, and a React Flow dashboard.

The core promise: when you ask "what breaks if I change `UserService.updateUser`?", you get an evidence-backed answer — every edge carries a source file, line, confidence (`static` 1.0 vs `inferred` 0.6), and a note explaining how it was resolved. Unresolved calls become diagnostics; they never become invented edges.

## Layout

```sh
packages/
  graph-core/             domain types, GraphRepository interface, GraphService (impact analysis)
  database/               node:sqlite storage behind GraphRepository (recursive-CTE traversal)
  analyzer-typescript/    TypeScript Compiler API analyzer (2 passes: extract, resolve)
  indexer/                incremental indexing (hash change detection, importer re-expansion)
apps/
  mcp-server/             MCP stdio server: 10 tools, 3 resources, 2 prompts
  api/                    Hono API for the dashboard (allowed-roots enforced)
  dashboard/              React + React Flow graph explorer
tests/
  fixtures/starter-hono/  deterministic fixture (critical scenario: UserController → UserService.updateUser → UserRepository.update)
  unit|integration|security/
```

## Setup

```sh
bun install
bun run typecheck   # tsc (3 projects)
bun run lint        # oxlint --deny-warnings
bun run test        # bun test
bun run build       # tsc + vite build apps/dashboard
bun run ci          # format:check && lint && typecheck && test:coverage && build
```

## MCP server (stdio)

```sh
MCP_GRAPH_REPOSITORY=/absolute/path/to/repo bun run apps/mcp-server/src/index.ts
```

On startup the server auto-indexes `MCP_GRAPH_ROOT` (or `MCP_GRAPH_REPOSITORY`, or the launch directory), so tools answer immediately; `index_repository` stays available for other projects.

Tools: `index_repository`, `search_symbols`, `get_symbol_details`, `find_dependents`, `find_dependencies`, `analyze_impact`, `get_dependency_path`, `find_related_tests`, `analyze_git_diff`, `get_graph_summary`.

Example client config (Claude Code / Cursor / Cline / Windsurf all use the same shape):

```json
{
  "mcpServers": {
    "dependency-graph": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/mcp-dependency-graph/apps/mcp-server/src/index.ts"],
      "env": { "MCP_GRAPH_REPOSITORY": "/absolute/path/to/your/repo" }
    }
  }
}
```

Optional env: `MCP_GRAPH_ROOT` (project to auto-index at startup), `MCP_GRAPH_DB` (graph SQLite path, default `$TMPDIR/mcpdg-graph.db`).

Ask things like:

- "What is affected if I change `UserService.updateUser`?"
- "Which tests cover `UserRepository.update`?"
- "Explain the dependency path from `routes.ts` to `UserRepository.update`."

## API + dashboard

One-time setup so `mcpdg` lands on your PATH:

```sh
cd apps/api && bun link
```

Then:

```sh
mcpdg                          # index cwd, serve API + UI, open the browser
mcpdg /path/to/repo            # index a specific project
mcpdg --port 9000 --no-open    # options: --port, --db, --no-open
mcpdg index /path/to/repo      # one-shot for agents/scripts: index, print
                               # IndexResult JSON on stdout, exit non-zero on
                               # failure (logs go to stderr)
```

The MCP server is the primary agent interface; `mcpdg index` gives agents and CI a headless way to bootstrap the same graph DB the dashboard and API read.

The dashboard's index bar (empty state and header) accepts a local path or a GitHub URL — GitHub sources are shallow-cloned into a temp dir (re-pulled on re-index) and never run code.

Dev mode with HMR:

```sh
bun run dev:api                          # http://127.0.0.1:8787
# in another shell:
bun run dev:dashboard                    # http://127.0.0.1:5173, proxies /api to :8787
```

The API rejects repository paths outside `allowedRoots` (`PATH_ESCAPE`) and caps pagination; SQL is fully parameterized (see `tests/security/`).

## Indexing semantics

- **Incremental:** content-hash change detection; changed files and their importers are re-analyzed.
- **Deletions/renames:** graph records for deleted files are removed; orphaned tables are pruned.
- **Confidence:** exact-name static resolution = 1.0; property calls via import bindings = 0.6 (`inferred`, noted on the edge); everything else = an `unresolved` diagnostic.
