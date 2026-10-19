# Relic

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
  api/                    Hono API + the publishable package: `relic` CLI and `relic-mcp` bins
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
bun run build       # tsc + vite dashboard + esbuild bundle (apps/api/dist)
bun run ci          # format:check && lint && typecheck && test:coverage && build
```

## Install

The published package ships both binaries and the prebuilt dashboard; it needs Node ≥ 23.4 (`node:sqlite`) or bun:

```sh
npm install -g relic-graph   # provides `relic` and `relic-mcp`
# or run ad hoc: npx relic-graph
```

## MCP server (stdio)

On startup the server auto-indexes `RELIC_ROOT` (or `RELIC_REPOSITORY`, or the launch directory), so tools answer immediately; `index_repository` stays available for other projects.

Tools: `index_repository`, `search_symbols`, `get_symbol_details`, `find_dependents`, `find_dependencies`, `analyze_impact`, `get_dependency_path`, `find_related_tests`, `analyze_git_diff`, `get_graph_summary`.

Example client config (Claude Code / Cursor / Cline / Windsurf all use the same shape):

```json
{
  "mcpServers": {
    "relic": {
      "command": "npx",
      "args": ["-y", "relic-graph"],
      "env": { "RELIC_REPOSITORY": "/absolute/path/to/your/repo" }
    }
  }
}
```

Optional env: `RELIC_ROOT` (project to auto-index at startup), `RELIC_DB` (graph SQLite path, default `$TMPDIR/relic.db`).

An agent skill lives in `skills/relic/SKILL.md`; it teaches LLM clients the query order and how to read confidence and evidence.

### Install the skill

Use the [skills](https://www.skills.sh/) CLI to install it into your agent:

```sh
npx skills add rjoydip/relic            # from GitHub
npx skills add .                       # or from this checkout
npx skills add . -g -a claude-code -y  # global, non-interactive
```

`npx skills list` shows what is installed. See the [skills docs](https://www.skills.sh/docs) for supported agents and options.

Ask things like:

- "What is affected if I change `UserService.updateUser`?"
- "Which tests cover `UserRepository.update`?"
- "Explain the dependency path from `routes.ts` to `UserRepository.update`."

## Dashboard

```sh
relic                          # index cwd, serve API + UI, open the browser
relic /path/to/repo            # index a specific project
relic --port 9000 --no-open    # options: --port, --db, --no-open
relic index /path/to/repo      # one-shot for agents/scripts: index, print
                               # IndexResult JSON on stdout, exit non-zero on
                               # failure (logs go to stderr)
```

The MCP server is the primary agent interface; `relic index` gives agents and CI a headless way to bootstrap the same graph DB the dashboard and API read.

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
