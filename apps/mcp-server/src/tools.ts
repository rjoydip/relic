import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphNode, GraphService, Indexer, SqliteGraphRepository } from "./deps";
import { GraphError } from "@relic/graph-core";
import { changedRanges, coerceNodeType, coerceRepositoryId, symbolsForRanges } from "./helpers";
import { z } from "zod";

export interface ToolDeps {
  graph: GraphService;
  indexer: Indexer;
  repository: SqliteGraphRepository;
}

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const failure = (err: unknown) => {
  if (err instanceof GraphError)
    return {
      content: [{ type: "text" as const, text: `ERROR [${err.code}]: ${err.message}` }],
      isError: true,
    };
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `ERROR [INTERNAL]: ${message}` }],
    isError: true,
  };
};

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { graph, indexer, repository } = deps;

  const repoId = (input?: string): string => {
    const path = input ?? process.env.RELIC_REPOSITORY;
    const id = coerceRepositoryId(
      path,
      (candidate) => repository.getRepository(candidate) !== null,
    );
    if (!repository.getRepository(id)) {
      throw new GraphError(
        "REPOSITORY_NOT_FOUND",
        `Repository not indexed yet: ${input ?? "(default)"}. Run index_repository first.`,
      );
    }
    return id;
  };

  const resolveTarget = (repo: string, nodeId?: string, symbol?: string): GraphNode => {
    if (nodeId) {
      const node = repository.getNode(nodeId);
      if (!node || node.repositoryId !== repo)
        throw new GraphError("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
      return node;
    }
    if (!symbol) throw new GraphError("INVALID_INPUT", "Provide either nodeId or symbol");
    const matches = graph.searchSymbols(repo, symbol);
    const exact = matches.filter((m) => m.name === symbol || m.qualifiedName === symbol);
    const pick = exact.length > 0 ? exact : matches.length === 1 ? matches : [];
    if (pick.length === 0) {
      throw new GraphError(
        "INVALID_INPUT",
        matches.length > 1
          ? `Symbol "${symbol}" is ambiguous; use nodeId. Matches: ${matches
              .slice(0, 5)
              .map((m) => m.qualifiedName ?? m.name)
              .join(", ")}`
          : `No symbol matches "${symbol}"`,
      );
    }
    return pick[0]!;
  };

  const run = <T>(fn: () => T): ReturnType<typeof json> | ReturnType<typeof failure> => {
    try {
      return json(fn());
    } catch (err) {
      return failure(err);
    }
  };

  server.registerTool(
    "index_repository",
    {
      description:
        "Create or refresh the dependency graph for a repository. Incremental: only changed files and their importers are re-analyzed.",
      inputSchema: {
        repository: z
          .string()
          .optional()
          .describe("Path to the repository root (defaults to RELIC_REPOSITORY)"),
        revision: z
          .string()
          .optional()
          .describe("Git revision to record as indexed (auto-detected when omitted)"),
      },
    },
    async ({ repository: path, revision }) =>
      run(() => {
        const root = path ?? process.env.RELIC_REPOSITORY;
        if (!root)
          throw new GraphError("INVALID_INPUT", "repository is required (or set RELIC_REPOSITORY)");
        return indexer.index(root, revision !== undefined ? { revision } : {});
      }),
  );

  server.registerTool(
    "search_symbols",
    {
      description:
        "Find functions, classes, methods, routes, tests, or tables in the indexed graph.",
      inputSchema: {
        repository: z.string().optional(),
        query: z.string().describe("Substring of the symbol name or qualified name"),
        type: z
          .string()
          .optional()
          .describe("Filter by node type (symbol, route, api_operation, database_table, test, …)"),
      },
    },
    async ({ repository: path, query, type }) =>
      run(() => {
        const repo = repoId(path);
        const results = graph.searchSymbols(repo, query, coerceNodeType(type));
        return { count: results.length, results };
      }),
  );

  server.registerTool(
    "get_symbol_details",
    {
      description:
        "Return a node's definition, incoming relationships, and outgoing dependencies with evidence.",
      inputSchema: {
        repository: z.string().optional(),
        nodeId: z.string().optional(),
        symbol: z.string().optional(),
      },
    },
    async ({ repository: path, nodeId, symbol }) =>
      run(() => {
        const repo = repoId(path);
        const target = resolveTarget(repo, nodeId, symbol);
        return graph.getSymbolDetails(repo, target.id);
      }),
  );

  server.registerTool(
    "analyze_impact",
    {
      description:
        "Identify direct and transitive effects of changing a symbol, file, route, or table.",
      inputSchema: {
        repository: z.string().optional(),
        symbol: z.string().optional().describe('e.g. "UserService.updateUser"'),
        nodeId: z.string().optional(),
        maxDepth: z.number().int().min(1).max(10).optional(),
        includeTests: z.boolean().optional(),
        includeIndirectDependencies: z.boolean().optional(),
      },
    },
    async ({
      repository: path,
      symbol,
      nodeId,
      maxDepth,
      includeTests,
      includeIndirectDependencies,
    }) =>
      run(() => {
        const repo = repoId(path);
        const target = resolveTarget(repo, nodeId, symbol);
        const options: { maxDepth?: number; includeTests?: boolean; includeIndirect?: boolean } =
          {};
        if (maxDepth !== undefined) options.maxDepth = maxDepth;
        if (includeTests !== undefined) options.includeTests = includeTests;
        if (includeIndirectDependencies !== undefined)
          options.includeIndirect = includeIndirectDependencies;
        return graph.analyzeImpact(repo, target.id, options);
      }),
  );

  server.registerTool(
    "find_dependents",
    {
      description: "Find reverse dependencies (who depends on this node).",
      inputSchema: {
        repository: z.string().optional(),
        nodeId: z.string().optional(),
        symbol: z.string().optional(),
        maxDepth: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ repository: path, nodeId, symbol, maxDepth }) =>
      run(() => {
        const repo = repoId(path);
        const target = resolveTarget(repo, nodeId, symbol);
        return { dependents: graph.findDependents(repo, target.id, maxDepth ?? 3) };
      }),
  );

  server.registerTool(
    "find_dependencies",
    {
      description: "Find outgoing dependencies (what this node depends on).",
      inputSchema: {
        repository: z.string().optional(),
        nodeId: z.string().optional(),
        symbol: z.string().optional(),
        maxDepth: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ repository: path, nodeId, symbol, maxDepth }) =>
      run(() => {
        const repo = repoId(path);
        const target = resolveTarget(repo, nodeId, symbol);
        return { dependencies: graph.findDependencies(repo, target.id, maxDepth ?? 3) };
      }),
  );

  server.registerTool(
    "find_related_tests",
    {
      description: "Recommend tests associated with a symbol or node.",
      inputSchema: {
        repository: z.string().optional(),
        nodeId: z.string().optional(),
        symbol: z.string().optional(),
      },
    },
    async ({ repository: path, nodeId, symbol }) =>
      run(() => {
        const repo = repoId(path);
        const target = resolveTarget(repo, nodeId, symbol);
        return { tests: graph.findRelatedTests(repo, target.id) };
      }),
  );

  server.registerTool(
    "analyze_git_diff",
    {
      description: "Identify symbols affected by a Git diff and their transitive impact.",
      inputSchema: {
        repository: z.string().optional(),
        base: z.string().optional().describe("Base revision (defaults to HEAD when omitted)"),
        head: z.string().optional().describe("Head revision (defaults to working tree)"),
        maxDepth: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ repository: path, base, head, maxDepth }) =>
      run(() => {
        const repo = repoId(path);
        const meta = repository.getRepository(repo)!;
        const ranges = changedRanges(meta.rootPath, base, head);
        const allNodes = ranges.flatMap((r) =>
          repository.listNodes({ repositoryId: repo, filePath: r.filePath, limit: 500 }),
        );
        const targets = symbolsForRanges(allNodes, ranges);
        const seen = new Map<string, { node: GraphNode; depth: number }>();
        for (const target of targets) {
          const impact = graph.analyzeImpact(repo, target.id, {
            maxDepth: maxDepth ?? 5,
            includeTests: true,
          });
          if (!seen.has(target.id)) seen.set(target.id, { node: target, depth: 0 });
          for (const row of impact.affected) {
            const prev = seen.get(row.node.id);
            if (!prev || row.depth < prev.depth)
              seen.set(row.node.id, { node: row.node, depth: row.depth });
          }
        }
        return {
          changedFiles: ranges.map((r) => ({ file: r.filePath, changedLines: r.lines.length })),
          changedTargets: targets,
          affected: [...seen.values()].sort((a, b) => a.depth - b.depth),
        };
      }),
  );

  server.registerTool(
    "get_dependency_path",
    {
      description: "Explain how two components connect: shortest known path of relationships.",
      inputSchema: {
        repository: z.string().optional(),
        from: z.string().describe("Source nodeId or symbol name"),
        to: z.string().describe("Target nodeId or symbol name"),
      },
    },
    async ({ repository: path, from, to }) =>
      run(() => {
        const repo = repoId(path);
        const source = resolveTarget(repo, undefined, from);
        const target = resolveTarget(repo, undefined, to);
        const steps = graph.getDependencyPath(repo, source.id, target.id);
        return { from: source, to: target, found: steps.length > 0, path: steps };
      }),
  );

  server.registerTool(
    "get_graph_summary",
    {
      description: "Return architecture summary and indexing status for a repository.",
      inputSchema: {
        repository: z.string().optional(),
      },
    },
    async ({ repository: path }) => run(() => graph.getSummary(repoId(path))),
  );

  // Resources.
  const defaultRepo = (): string => repoId(process.env.RELIC_REPOSITORY);
  server.registerResource(
    "repository-summary",
    "graph://repository/summary",
    { mimeType: "application/json", description: "Graph and indexing statistics" },
    async () => ({
      contents: [
        {
          uri: "graph://repository/summary",
          mimeType: "application/json",
          text: JSON.stringify(graph.getSummary(defaultRepo()), null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    "index-status",
    "graph://repository/index-status",
    { mimeType: "application/json", description: "Last index revision, duration, diagnostics" },
    async () => {
      const summary = graph.getSummary(defaultRepo());
      return {
        contents: [
          {
            uri: "graph://repository/index-status",
            mimeType: "application/json",
            text: JSON.stringify(
              {
                lastRevision: summary.lastRevision,
                indexedAt: summary.indexedAt,
                durationMs: summary.indexingDurationMs,
                fileCount: summary.fileCount,
                diagnostics: summary.diagnostics,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
  server.registerResource(
    "components",
    "graph://repository/components",
    { mimeType: "application/json", description: "Bounded list of indexed components" },
    async () => {
      const repo = defaultRepo();
      const nodes = graph.searchSymbols(repo, "");
      return {
        contents: [
          {
            uri: "graph://repository/components",
            mimeType: "application/json",
            text: JSON.stringify(
              { count: nodes.length, truncated: nodes.length >= 50, nodes },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // Prompts.
  server.registerPrompt(
    "impact-analysis",
    {
      description: "Trace the impact of a change with evidence and test recommendations",
      argsSchema: { symbol: z.string() },
    },
    ({ symbol }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Analyze the impact of changing "${symbol}". Use analyze_impact and get_symbol_details on the dependency graph. Report: (1) direct and transitive affected symbols with evidence and confidence, (2) API routes and database entities involved, (3) relevant tests, (4) unresolved or inferred relationships that deserve manual review.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "code-review",
    {
      description: "Review a change using graph relationships",
      argsSchema: { summary: z.string() },
    },
    ({ summary }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Review this change using the dependency graph: ${summary}. Use analyze_git_diff to find affected symbols, then flag likely regressions: callers not covered by tests, routes whose contracts change, and inferred (confidence < 1.0) relationships that could be wrong.`,
          },
        },
      ],
    }),
  );
}
