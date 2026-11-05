import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  extractFile,
  makeRepositoryContext,
  relate,
  resolveImport,
  walkRepository,
  type RefInfo,
  type RefLookup,
} from "@relic/analyzer-typescript";
import { FIXTURE_ROOT } from "../../helpers";

const repo = makeRepositoryContext(join(FIXTURE_ROOT, "..", "alias-repo"));

function lookupFrom(all: RefInfo[]): RefLookup {
  return {
    findByName: (name) =>
      all.filter(
        (r) => r.name === name || r.qualifiedName === name || r.qualifiedName.endsWith(`.${name}`),
      ),
  };
}

describe("import resolution with tsconfig paths and workspaces", () => {
  it("resolves path aliases, baseUrl, and workspace siblings", () => {
    expect(resolveImport(repo, "src/app.ts", "@/util")).toEqual({
      kind: "ok",
      path: "src/util.ts",
    });
    expect(resolveImport(repo, "src/app.ts", "@shared/config")).toEqual({
      kind: "ok",
      path: "src/shared/config.ts",
    });
    expect(resolveImport(repo, "src/app.ts", "@fixture/lib")).toEqual({
      kind: "ok",
      path: "packages/lib/src/index.ts",
    });
    expect(resolveImport(repo, "src/app.ts", "@fixture/lib/math")).toEqual({
      kind: "ok",
      path: "packages/lib/src/math.ts",
    });
    expect(resolveImport(repo, "src/app.ts", "react")).toEqual({ kind: "external" });
  });

  it("reports an unknown configured alias instead of treating it as external", () => {
    const extracted = extractFile(repo, "src/broken.ts");
    expect(
      extracted.diagnostics.some(
        (d) => d.kind === "unresolved" && d.message.includes('"@/missing"'),
      ),
    ).toBe(true);
  });

  it("links imports and calls across aliases", () => {
    const files = walkRepository(repo.rootPath).map((path) => extractFile(repo, path));
    const lookup = lookupFrom(files.flatMap((file) => file.refs));
    const app = files.find((file) => file.filePath === "src/app.ts")!;
    const { edges, diagnostics } = relate(repo, app, lookup);

    const imports = edges.filter((edge) => edge.type === "IMPORTS");
    expect(imports).toHaveLength(4);

    const byId = new Map(files.flatMap((file) => file.refs).map((ref) => [ref.id, ref]));
    const called = edges
      .filter((edge) => edge.type === "CALLS")
      .map((edge) => byId.get(edge.targetId)?.name)
      .filter(Boolean)
      .sort();
    expect(called).toEqual(["double", "greet", "libGreeting"]);
    expect(diagnostics.filter((d) => d.kind === "unresolved")).toEqual([]);
  });
});
