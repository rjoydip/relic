import { describe, expect, it } from "bun:test";
import type { GraphNode, GraphRepository, GraphService } from "@relic/graph-core";
import type { ChangedRange } from "@relic/indexer";
import { aggregatePrImpact, formatPrImpact, type PrImpact } from "../../../apps/api/src/pr";

const node = (name: string, filePath: string, type: GraphNode["type"] = "symbol"): GraphNode => ({
  id: name,
  repositoryId: "r",
  type,
  name,
  qualifiedName: name,
  filePath,
  startLine: 4,
  endLine: 8,
  metadata: {},
  updatedAt: "",
});

const report: PrImpact = {
  changedFiles: [{ filePath: "src/services/user.ts", changedLines: 3 }],
  changedSymbols: [node("UserService.updateUser", "src/services/user.ts")],
  affected: [
    {
      node: node("UserController.updateUser", "src/controllers/user.ts"),
      relationship: "CALLS",
      depth: 1,
      confidence: 0.6,
      evidence: { source: "inferred", file: "src/controllers/user.ts", line: 9 },
    },
  ],
  tests: [node("user.service.test.ts", "tests/user.service.test.ts", "test")],
  risk: 42,
  diagnostics: 2,
};

describe("PR impact markdown", () => {
  it("lists blast radius, tests, risk, and coverage caveats", () => {
    const markdown = formatPrImpact(report);
    expect(markdown).toContain("## Relic impact");
    expect(markdown).toContain("**Risk:** 42/100");
    expect(markdown).toContain("2 unresolved relationships");
    expect(markdown).toContain("`UserService.updateUser`");
    expect(markdown).toContain("`UserController.updateUser` — CALLS · depth 1 · 60%");
    expect(markdown).toContain("`user.service.test.ts`");
    expect(markdown).not.toContain("function updateUser");
    expect(markdown).toContain("<details>");
    expect(markdown).toContain("<summary>Blast radius (1)</summary>");
  });

  it("handles an empty diff", () => {
    const markdown = formatPrImpact({
      changedFiles: [],
      changedSymbols: [],
      affected: [],
      tests: [],
      risk: 0,
      diagnostics: 0,
    });
    expect(markdown).toContain("_No changed files detected._");
    expect(markdown).toContain("_No indexed symbols intersect the changed lines._");
    expect(markdown).toContain("_Nothing depends on the changed symbols._");
  });
});

describe("PR impact aggregation", () => {
  it("resolves changed symbols, blast radius, tests, and diagnostics", () => {
    const changed = node("UserService.updateUser", "src/services/user.ts");
    const caller = node("UserController.updateUser", "src/controllers/user.ts");
    const related = node("user.service.test.ts", "tests/user.service.test.ts", "test");
    const ranges: ChangedRange[] = [{ filePath: "src/services/user.ts", lines: [5] }];

    const repository = {
      listNodes: ({ filePath }: { filePath?: string }) =>
        filePath === "src/services/user.ts" ? [changed] : [],
      getRepository: () => ({
        diagnostics: [{ kind: "unresolved", message: "one dangling" }],
      }),
    } as unknown as GraphRepository;
    const graph = {
      analyzeImpact: () => ({
        affected: [
          {
            node: caller,
            relationship: "CALLS",
            direction: "upstream",
            depth: 1,
            confidence: 0.6,
            evidence: { source: "inferred", file: "src/controllers/user.ts", line: 9 },
          },
        ],
        summary: { risk: { score: 42 } },
      }),
      findRelatedTests: () => [related],
    } as unknown as GraphService;

    const report = aggregatePrImpact(graph, repository, "r", ranges);
    expect(report.changedFiles).toEqual([{ filePath: "src/services/user.ts", changedLines: 1 }]);
    expect(report.changedSymbols.map((n) => n.name)).toEqual(["UserService.updateUser"]);
    expect(report.affected.map((row) => row.node.name)).toEqual([
      "UserService.updateUser",
      "UserController.updateUser",
    ]);
    expect(report.tests.map((n) => n.name)).toEqual(["user.service.test.ts"]);
    expect(report.risk).toBe(42);
    expect(report.diagnostics).toBe(1);
  });
});
