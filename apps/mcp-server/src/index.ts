import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openGraph, type OpenGraph } from "@mcpdg/indexer";
import { registerTools } from "./tools";

/** Wire a configured MCP server (used by main and protocol tests). */
export function createMcpServer(options: { dbPath?: string } = {}): {
  server: McpServer;
  graph: OpenGraph;
  close: () => void;
} {
  const dbPath = options.dbPath ?? process.env.MCP_GRAPH_DB ?? join(tmpdir(), "mcpdg-graph.db");
  const graph = openGraph(dbPath);
  const server = new McpServer({ name: "mcp-dependency-graph", version: "0.1.0" });
  registerTools(server, {
    graph: graph.graph,
    indexer: graph.indexer,
    repository: graph.repository,
  });
  return { server, graph, close: graph.close };
}

export async function main(): Promise<void> {
  const { server, graph } = createMcpServer();
  // Auto-index the launch directory (or an explicit project) so tools answer
  // immediately; failures degrade to the index_repository tool.
  const root = process.env.MCP_GRAPH_ROOT ?? process.env.MCP_GRAPH_REPOSITORY ?? process.cwd();
  try {
    const result = graph.indexer.index(root);
    console.error(`auto-indexed ${root}: ${result.nodeCount} nodes, ${result.edgeCount} edges`);
  } catch (err) {
    console.error(`auto-index skipped for ${root}:`, err instanceof Error ? err.message : err);
  }
  const transport = new StdioServerTransport();
  // stdout is reserved for protocol messages; logs go to stderr.
  console.error("mcp-dependency-graph server running on stdio");
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
