import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanup, copyFixture, PROJECT_ROOT, tempDir } from "../helpers";

let fixture: { root: string; cleanup: () => void };
let dbDir: string;
let client: Client;
let transport: StdioClientTransport;

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  return result as unknown as ToolResult;
}

function parse(result: ToolResult): unknown {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as unknown;
}

beforeEach(async () => {
  fixture = copyFixture();
  dbDir = tempDir();
  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(PROJECT_ROOT, "apps", "mcp-server", "src", "index.ts")],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      SKEIN_DB: join(dbDir, "graph.db"),
      SKEIN_REPOSITORY: fixture.root,
    } as Record<string, string>,
    stderr: "ignore",
  });
  client = new Client({ name: "protocol-test", version: "0.0.0" });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close();
  fixture.cleanup();
  await cleanup([dbDir]);
});

describe("MCP protocol over stdio", () => {
  it("discovers the full tool, resource, and prompt surface", { timeout: 30_000 }, async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "analyze_git_diff",
      "analyze_impact",
      "find_dependencies",
      "find_dependents",
      "find_related_tests",
      "get_dependency_path",
      "get_graph_summary",
      "get_symbol_details",
      "index_repository",
      "search_symbols",
    ]);
    // Input schemas are documented and typed.
    const impact = tools.tools.find((t) => t.name === "analyze_impact")!;
    expect(JSON.stringify(impact.inputSchema)).toContain("symbol");

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri).sort()).toEqual([
      "graph://repository/components",
      "graph://repository/index-status",
      "graph://repository/summary",
    ]);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual(["code-review", "impact-analysis"]);
  });

  it("indexes a repository and returns an impact report", { timeout: 30_000 }, async () => {
    const indexResult = await call("index_repository");
    expect(indexResult.isError).toBeFalsy();
    const indexed = parse(indexResult) as { repositoryId: string; edgeCount: number };
    expect(indexed.edgeCount).toBeGreaterThan(15);

    const impactResult = await call("analyze_impact", {
      symbol: "UserService.updateUser",
      maxDepth: 5,
      includeTests: true,
    });
    expect(impactResult.isError).toBeFalsy();
    const impact = parse(impactResult) as {
      target: { qualifiedName: string };
      affected: Array<{
        node: { qualifiedName: string | null; type: string };
        relationship: string;
        depth: number;
        confidence: number;
        evidence: { file: string; line: number };
      }>;
      summary: { affectedTests: number };
    };
    expect(impact.target.qualifiedName).toBe("UserService.updateUser");
    const qualified = impact.affected.map((a) => a.node.qualifiedName);
    expect(qualified).toContain("UserController.updateUser");
    expect(qualified).toContain("Mutation.updateUser");
    expect(qualified).toContain("ws:user:update");
    const controller = impact.affected.find(
      (a) => a.node.qualifiedName === "UserController.updateUser",
    )!;
    expect(controller.relationship).toBe("CALLS");
    expect(controller.evidence.file).toBe("src/controllers/user.ts");
    expect(controller.evidence.line).toBeGreaterThan(0);
    expect(impact.summary.affectedTests).toBeGreaterThanOrEqual(1);

    // The other tools work against the same graph.
    const search = parse(await call("search_symbols", { query: "updateUser", type: "symbol" })) as {
      results: unknown[];
    };
    expect(search.results.length).toBeGreaterThan(0);
    const summary = parse(await call("get_graph_summary")) as { counts: { edges: number } };
    expect(summary.counts.edges).toBeGreaterThan(15);
    const tests = parse(await call("find_related_tests", { symbol: "UserService.updateUser" })) as {
      tests: Array<{ name: string }>;
    };
    expect(tests.tests.some((t) => t.name.includes("user.service.test.ts"))).toBe(true);

    // Resources answer with JSON.
    const resource = await client.readResource({ uri: "graph://repository/index-status" });
    const status = JSON.parse((resource.contents[0] as { text: string }).text) as {
      fileCount: number;
    };
    expect(status.fileCount).toBeGreaterThanOrEqual(9);
  });

  it(
    "returns stable error codes for unknown symbols and repositories",
    { timeout: 30_000 },
    async () => {
      await call("index_repository");
      const missing = await call("analyze_impact", { symbol: "Nope.notARealSymbol" });
      expect(missing.isError).toBe(true);
      expect(missing.content[0]?.text).toContain("ERROR [INVALID_INPUT]");

      const badRepo = await call("get_graph_summary", {
        repository: "repo_does_not_exist_or_path_without_index",
      });
      expect(badRepo.isError).toBe(true);
      expect(badRepo.content[0]?.text).toContain("ERROR [REPOSITORY_NOT_FOUND]");
    },
  );
});
