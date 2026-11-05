import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { GraphEdge, GraphNode } from "@relic/graph-core";
import { evaluateBoundaries, globMatch, loadBoundaryConfig } from "../../../apps/api/src/check";

const node = (id: string, filePath: string): GraphNode => ({
  id,
  repositoryId: "r",
  type: "file",
  name: filePath,
  qualifiedName: null,
  filePath,
  startLine: 1,
  endLine: 2,
  metadata: {},
  updatedAt: "",
});

const edge = (
  sourceId: string,
  targetId: string,
  type: GraphEdge["type"] = "IMPORTS",
): GraphEdge => ({
  id: `${sourceId}->${targetId}`,
  repositoryId: "r",
  sourceId,
  targetId,
  type,
  confidence: 1,
  evidence: { source: "static", file: `${sourceId}.ts`, line: 4 },
});

const nodes = new Map([
  ["ui", node("ui", "src/ui/button.ts")],
  ["db", node("db", "src/database/client.ts")],
  ["svc", node("svc", "src/services/user.ts")],
]);
const nodeById = (id: string) => nodes.get(id) ?? null;

describe("globMatch", () => {
  it("supports ** across directories", () => {
    expect(globMatch("src/ui/**", "src/ui/button.ts")).toBe(true);
    expect(globMatch("src/ui/**", "src/ui/deep/button.ts")).toBe(true);
    expect(globMatch("src/**/button.ts", "src/button.ts")).toBe(true);
    expect(globMatch("src/**/button.ts", "src/ui/button.ts")).toBe(true);
    expect(globMatch("src/ui/*", "src/ui/deep/button.ts")).toBe(false);
  });

  it("supports ? and exact paths", () => {
    expect(globMatch("src/?.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/?.ts", "src/ab.ts")).toBe(false);
    expect(globMatch("src/ui/button.ts", "src/ui/button.ts")).toBe(true);
  });
});

describe("evaluateBoundaries", () => {
  const rules = [
    {
      from: "src/ui/**",
      to: "src/database/**",
      message: "UI must not import database",
    },
  ];

  it("reports violating edges with evidence", () => {
    const violations = evaluateBoundaries([edge("ui", "db")], nodeById, rules);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.fromFile).toBe("src/ui/button.ts");
    expect(violations[0]?.toFile).toBe("src/database/client.ts");
    expect(violations[0]?.rule.message).toBe("UI must not import database");
    expect(violations[0]?.edge.evidence.line).toBe(4);
  });

  it("ignores allowed imports and other edge types", () => {
    expect(evaluateBoundaries([edge("ui", "svc")], nodeById, rules)).toEqual([]);
    expect(evaluateBoundaries([edge("ui", "db", "CALLS")], nodeById, rules)).toEqual([]);
  });

  it("respects a per-rule edge type override", () => {
    const violations = evaluateBoundaries([edge("ui", "db", "CALLS")], nodeById, [
      { ...rules[0]!, edgeTypes: ["CALLS"] },
    ]);
    expect(violations).toHaveLength(1);
  });
});

describe("loadBoundaryConfig", () => {
  it("loads .relicrc.json, filters invalid rules, and supports explicit paths", () => {
    const root = mkdtempSync(join(tmpdir(), "relic-check-"));
    try {
      writeFileSync(
        join(root, ".relicrc.json"),
        JSON.stringify({
          boundaries: [
            { from: "src/ui/**", to: "src/db/**", message: "no" },
            { from: "", to: "src/db/**" },
          ],
        }),
      );
      const config = loadBoundaryConfig(root);
      expect(config?.source).toBe(join(root, ".relicrc.json"));
      expect(config?.rules).toHaveLength(1);

      const explicit = join(root, "custom.json");
      writeFileSync(explicit, JSON.stringify({ boundaries: [{ from: "a/**", to: "b/**" }] }));
      expect(loadBoundaryConfig(root, explicit)?.rules).toHaveLength(1);
      expect(loadBoundaryConfig(root, join(root, "missing.json"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
