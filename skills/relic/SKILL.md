---
name: relic
description: Query the Relic dependency graph before changing code. Use when asked what depends on a symbol, what breaks if X changes, which tests cover X, how two files/routes/tables connect, or to review a git diff. Requires the "relic" MCP server.
---

# Relic graph

Facts over guesses. Prefer graph answers to grep/read; never invent relationships.

## Before you answer

1. `get_graph_summary` confirms the repo is indexed and lists `diagnostics`.
   - `REPOSITORY_NOT_FOUND` -> call `index_repository` first.
   - Old `indexedAt`, or after a pull/branch switch -> `index_repository`
     (incremental, cheap). Don't re-index per question.
2. `search_symbols(query)` to resolve names, then reuse the returned `id` as
   `nodeId` in later calls — names can be ambiguous.
3. If a tool reports `ambiguous`, do not retry the bare name; pick a `nodeId`
   from `search_symbols`.

## Tool routing

- "what breaks if I change X" -> `analyze_impact(symbol|nodeId, includeTests: true)`
- "who uses X" -> `find_dependents`
- "what does X use" -> `find_dependencies`
- "which tests cover X" -> `find_related_tests`
- "how does A reach B" -> `get_dependency_path(from, to)`
- "review this change" -> `analyze_git_diff(base, head)`, then `analyze_impact`
  on each changed target
- Cheap context without a tool call -> resources
  `graph://repository/summary`, `index-status`, `components`

## Reporting rules

- Pass `repository` (absolute path) unless the server auto-indexes your project
  via `RELIC_ROOT` / `RELIC_REPOSITORY`.
- Every edge carries `confidence` and `evidence`. Static (1.0) is a fact;
  inferred (0.6) is a convention-based guess — label it as such.
- Cite `evidence.file:line`. If evidence is missing, say "inferred".
- `diagnostics` / `unresolved` mean unknown coverage, not "safe".
- Absence from `affected` does not prove a symbol is unaffected.
- `analyze_impact` depth caps at 10 and `get_dependency_path` at 8 hops — say
  "no path within the limit", not "no dependency".

## Do not

- Do not re-index on every question.
- Do not use the graph instead of reading the changed file itself.
