import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { GraphNode } from "@relic/graph-core";
import { changedRanges, symbolsForRanges } from "@relic/indexer";

const node = (id: string, name: string, startLine: number, endLine: number): GraphNode => ({
  id,
  repositoryId: "r",
  type: "symbol",
  name,
  qualifiedName: name,
  filePath: "src/a.ts",
  startLine,
  endLine,
  metadata: {},
  updatedAt: "",
});

function git(root: string, ...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

describe("git diff ranges", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "relic-changes-"));
    git(root, "init");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "a.ts"), "line1\nline2\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "first");
    writeFileSync(join(root, "a.ts"), "line1\nchanged\nline3\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("maps changed hunks to new-side lines", () => {
    const ranges = changedRanges(root, "HEAD");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.filePath).toBe("a.ts");
    expect(ranges[0]?.lines).toContain(2);
    expect(ranges[0]?.lines).toContain(3);
  });

  it("throws a GraphError outside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "relic-no-git-"));
    try {
      expect(() => changedRanges(outside)).toThrow("git diff failed");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("symbolsForRanges", () => {
  it("returns symbols whose line range intersects a change", () => {
    const targets = symbolsForRanges(
      [node("a", "a", 1, 3), node("b", "b", 10, 12), node("c", "c", 4, 8)],
      [{ filePath: "src/a.ts", lines: [3, 11] }],
    );
    expect(targets.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("ignores non-symbols and symbols without ranges", () => {
    const file: GraphNode = { ...node("f", "f", 1, 2), type: "file" };
    const missing: GraphNode = { ...node("m", "m", 1, 2), startLine: null };
    expect(symbolsForRanges([file, missing], [{ filePath: "src/a.ts", lines: [1] }])).toEqual([]);
  });
});
