import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { GraphNode } from "@relic/graph-core";
import {
  MAX_EXCERPT_LINES,
  coerceNodeType,
  coerceRepositoryId,
  sourceExcerpt,
} from "../../../apps/mcp/src/helpers";

const node = (overrides: Partial<GraphNode>): GraphNode => ({
  id: "n1",
  repositoryId: "r1",
  type: "symbol",
  name: "big",
  qualifiedName: "big",
  filePath: "big.ts",
  startLine: 1,
  endLine: 200,
  metadata: {},
  updatedAt: "",
  ...overrides,
});

describe("sourceExcerpt", () => {
  it("returns a line-numbered window capped at MAX_EXCERPT_LINES", () => {
    const root = mkdtempSync(join(tmpdir(), "relic-excerpt-"));
    try {
      writeFileSync(
        join(root, "big.ts"),
        Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"),
      );
      const excerpt = sourceExcerpt(root, node({ startLine: 10, endLine: 190 }))!;
      expect(excerpt.lines).toHaveLength(MAX_EXCERPT_LINES);
      expect(excerpt.lines[0]).toEqual({ line: 10, text: "line 10" });
      expect(excerpt.endLine).toBe(89);
      expect(excerpt.totalLines).toBe(181);
      expect(excerpt.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null without a file or for missing files", () => {
    const root = mkdtempSync(join(tmpdir(), "relic-excerpt-"));
    try {
      expect(sourceExcerpt(root, node({ filePath: null }))).toBeNull();
      expect(sourceExcerpt(root, node({ filePath: "missing.ts" }))).toBeNull();
      expect(sourceExcerpt(root, node({ filePath: "../escape.ts" }))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("input coercion", () => {
  it("keeps an indexed id, resolves a path, and rejects empty repositories", () => {
    expect(coerceRepositoryId("repo_123", (id) => id === "repo_123")).toBe("repo_123");
    expect(coerceRepositoryId("C:/code", () => false)).toMatch(/^repo_/);
    expect(() => coerceRepositoryId("   ", () => false)).toThrow("repository is required");
  });

  it("accepts known node types and rejects unknown ones", () => {
    expect(coerceNodeType(undefined)).toBeUndefined();
    expect(coerceNodeType("symbol")).toBe("symbol");
    expect(() => coerceNodeType("nonsense")).toThrow("Unknown node type");
  });
});
