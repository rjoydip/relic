import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openGraph, type OpenGraph } from "@skein/indexer";
import { registerTools } from "./tools";

/** Wire a configured MCP server (used by main and protocol tests). */
export function createMcpServer(options: { dbPath?: string } = {}): {
  server: McpServer;
  graph: OpenGraph;
  close: () => void;
} {
  const dbPath = options.dbPath ?? process.env.SKEIN_DB ?? join(tmpdir(), "skein.db");
  const graph = openGraph(dbPath);
  const server = new McpServer({ name: "skein", version: "0.1.0" });
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
  const root = process.env.SKEIN_ROOT ?? process.env.SKEIN_REPOSITORY ?? process.cwd();
  try {
    const result = graph.indexer.index(root);
    console.error(`auto-indexed ${root}: ${result.nodeCount} nodes, ${result.edgeCount} edges`);
  } catch (err) {
    console.error(`auto-index skipped for ${root}:`, err instanceof Error ? err.message : err);
  }
  const transport = new StdioServerTransport();
  // stdout is reserved for protocol messages; logs go to stderr.
  console.error("skein server running on stdio");
  await server.connect(transport);
}

// import.meta.main is bun-only; the argv comparison is the Node idiom so the
// bundled dist entry (skein-mcp bin) also auto-runs on Node.
const isMain =
  Boolean(import.meta.main) ||
  (Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
