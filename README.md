<p align="center">
  <img src="docs/public/logo.svg" alt="Relic" width="128" height="128" />
</p>

# Relic

Static dependency-graph engine for TypeScript/JavaScript, Python, Rust, Java and Go repositories, exposed three ways: an MCP server (for coding agents), a Hono HTTP API, and a React Flow dashboard. It also ingests docker-compose, Dockerfile and Kubernetes manifests and runtime coverage evidence.

The core promise: when you ask "what breaks if I change `UserService.updateUser`?", you get an evidence-backed answer — every edge carries a source file, line, confidence (`static` 1.0 vs `inferred` 0.6), and a note explaining how it was resolved. Unresolved calls become diagnostics; they never become invented edges.

## Layout

```sh
packages/
  core/                   domain types, GraphRepository interface, GraphService (impact analysis)
  database/               node:sqlite storage behind GraphRepository (recursive-CTE traversal)
  analyzer/
    core/                 shared analyzer contract, discovery, resolver, manifests
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
  fixtures/analyzer/typescript/  deterministic fixture (critical scenario: UserController → UserService.updateUser → UserRepository.update)
  fixtures/analyzer/{python,go,java,rust}/  per-language analyzer fixtures
  fixtures/{cross-repo,infra}/   workspace and deployment scenarios
  unit|integration|security/
```

## Setup

```sh
bun install
bun run typecheck   # tsc (3 projects)
bun run lint        # oxlint --deny-warnings
bun run test        # bun test
bun run build       # tsc + vite dashboard + docs + esbuild bundle (apps/api/dist)
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

Tools: `index_repository`, `search_symbols`, `search_semantic`, `get_symbol_details`, `find_dependents`, `find_dependencies`, `find_cycles`, `find_dead_code`, `get_owners`, `analyze_impact`, `get_dependency_path`, `find_related_tests`, `analyze_git_diff`, `ingest_runtime`, `get_graph_summary`.

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

`relic init` does the same setup non-interactively: it merges `.mcp.json` (pointing at this repository) and writes `skills/relic/SKILL.md`. Re-running it is a no-op; `--force` replaces a modified skill.

Ask things like:

- "What is affected if I change `UserService.updateUser`?"
- "Which tests cover `UserRepository.update`?"
- "Explain the dependency path from `routes.ts` to `UserRepository.update`."

## Dashboard

```sh
relic                          # index cwd, serve API + UI, open the browser
relic /path/to/repo            # index a specific project
relic --port 9000 --no-open    # options: --port, --db, --no-open, --watch
relic index /path/to/repo      # one-shot for agents/scripts: index, print
                               # IndexResult JSON on stdout, exit non-zero on
                               # failure (logs go to stderr)
```

`--watch` re-indexes incrementally on file changes and pushes `graph-updated`
events over SSE (`/api/events`), so open dashboards refresh without a reload.
Branch switches are not detected as a single event — run `relic index` (or
restart `relic`) after a checkout.

### Impact, export, check, init, PR reports

```sh
relic impact UserService.updateUser --json       # blast radius + risk score
relic export --format mermaid > graph.mmd        # mermaid | dot
relic check                                      # boundary rules, exit 1 on violation
relic init                                       # .mcp.json + skills/relic/SKILL.md
relic pr --base origin/main --head HEAD          # Markdown blast radius for a PR
relic diff before.json after.json --check        # snapshot drift
relic runtime coverage.lcov                      # lcov | OTLP JSON runtime evidence
```

Boundary rules live in `.relicrc.json` (or `relic.config.json`); each rule
matches importer/imported paths and defaults to `IMPORTS` edges:

```json
{
  "boundaries": [
    { "from": "src/ui/**", "to": "src/database/**", "message": "UI must not import database" }
  ]
}
```

The MCP server is the primary agent interface; `relic index` gives agents and CI a headless way to bootstrap the same graph DB the dashboard and API read.

### Comment impact on pull requests

`.github/actions/relic-pr` is a composite action that runs `relic pr`, writes
the Markdown report, and posts it with `gh pr comment`. It needs a checkout
with `fetch-depth: 0`, `contents: read`, and `pull-requests: write`; source
code never leaves the runner, only symbol names, paths, and test names.

```yaml
permissions:
  contents: read
  pull-requests: write
steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 }
  - uses: ./.github/actions/relic-pr
    with:
      base: origin/${{ github.base_ref }}
      head: HEAD
```

This repository dogfoods it in `.github/workflows/relic-pr.yml`.

The dashboard's index bar (empty state and header) accepts a local path or a GitHub URL — GitHub sources are shallow-cloned into a temp dir (re-pulled on re-index) and never run code.

Dev mode with HMR:

```sh
bun run dev            # API :8787 + dashboard :5173 + docs :5174
```

The dashboard proxies `/api` to the API and `/docs/` to the docs server.
`bun run build` builds the docs into the dashboard output too, so the packaged
`relic` command serves them at `/docs/`.

The API rejects repository paths outside `allowedRoots` (`PATH_ESCAPE`) and caps pagination; SQL is fully parameterized (see `tests/security/`).

## Deployment

The dashboard and docs ship as one assets-only Cloudflare Worker, managed by
[Alchemy](https://alchemy.run): dashboard at `/`, docs at `/docs/`.

```sh
bun run site:build   # dashboard + docs -> apps/dashboard/dist
bun run deploy       # alchemy deploy
```

The first deploy needs an Alchemy state store on the account — run
`bun alchemy state bootstrap` once (CI sets `CI=true`, which refuses to create
it implicitly). `.github/workflows/deploy.yml` builds and deploys on pushes to
`main` using `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`.

Only the static surface is deployed. The API stays local: it depends on
`node:sqlite`, child processes and filesystem indexing, none of which run in a
Worker. The deployed dashboard detects the missing API, disables indexing and
re-indexing, and lets you load a Relic snapshot file entirely in the browser to
explore a graph read-only.

To use indexing on a deployed dashboard, host the API somewhere that can run
Node (container or VM) and build the dashboard with its origin:

```sh
VITE_RELIC_API_URL=https://relic-api.example.com bun run site:build
```

The build then calls `https://relic-api.example.com/api/*` instead of `/api/*`.

## Indexing semantics

- **Incremental:** content-hash change detection; changed files and their importers are re-analyzed.
- **Deletions/renames:** graph records for deleted files are removed; orphaned tables are pruned.
- **Confidence:** exact-name static resolution = 1.0; property calls via import bindings = 0.6 (`inferred`, noted on the edge); everything else = an `unresolved` diagnostic.
