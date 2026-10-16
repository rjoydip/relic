import { describe, expect, test } from "bun:test";
import type { GraphNodeDto } from "../../../apps/dashboard/src/api";
import { ancestorsOf, buildTree } from "../../../apps/dashboard/src/tree";

function node(over: Partial<GraphNodeDto> & { id: string }): GraphNodeDto {
  return {
    type: "symbol",
    name: "x",
    qualifiedName: null,
    filePath: null,
    startLine: null,
    endLine: null,
    ...over,
  };
}

describe("buildTree", () => {
  // regression: a file emitted as a leaf AND as parent of its symbols makes
  // @pierre/trees throw "Path collides with an existing file while creating
  // directory" — the file must become an implicit directory row instead
  test("a file with symbols becomes a directory row, not a colliding leaf", () => {
    const { paths, map } = buildTree([
      node({ id: "f", type: "file", name: "playwright.ts", filePath: "tests/playwright.ts" }),
      node({ id: "s1", name: "run", filePath: "tests/playwright.ts" }),
      node({ id: "s2", name: "boot", filePath: "tests/playwright.ts" }),
    ]);
    expect(paths).toEqual(["tests/playwright.ts/boot", "tests/playwright.ts/run"]);
    // the directory row still resolves to the file node on click
    expect(map.get("tests/playwright.ts")?.id).toBe("f");
    expect(map.get("tests/playwright.ts/run")?.id).toBe("s1");
  });

  test("childless files stay leaves; windows separators normalize", () => {
    const { paths, map } = buildTree([
      node({ id: "a", type: "file", name: "b.ts", filePath: "src\\b.ts" }),
      node({ id: "s", name: "loose", filePath: null }),
    ]);
    expect(paths).toEqual(["loose", "src/b.ts"]);
    expect(map.get("src/b.ts")?.id).toBe("a");
  });

  test("empty input yields an empty tree", () => {
    expect(buildTree([])).toEqual({ paths: [], map: new Map() });
  });
});

describe("ancestorsOf", () => {
  test("collects every parent prefix, directories and files alike", () => {
    expect(ancestorsOf(["a/b/c.ts/x", "a/b/d.ts/y"])).toEqual(["a", "a/b", "a/b/c.ts", "a/b/d.ts"]);
  });
});
