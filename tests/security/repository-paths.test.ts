import { describe, expect, it } from "bun:test";
import {
  makeRepositoryContext,
  resolveImport,
  toRepoRelative,
  walkRepository,
} from "@relic/analyzer-typescript";
import { FIXTURE_ROOT } from "../helpers";

const repo = makeRepositoryContext(FIXTURE_ROOT);

describe("repository boundary enforcement", () => {
  it("refuses to build relative paths that escape the repository root", () => {
    expect(() => toRepoRelative(repo.rootPath, `${repo.rootPath}/../../../etc/passwd`)).toThrow(
      /escapes repository boundary/,
    );
    expect(() => toRepoRelative(repo.rootPath, "C:\\Windows\\System32\\config")).toThrow(
      /escapes repository boundary/,
    );
    expect(toRepoRelative(repo.rootPath, `${repo.rootPath}/src/routes.ts`)).toBe("src/routes.ts");
  });

  it("classifies import specifiers that leave the repository as escape", () => {
    expect(resolveImport(repo, "src/routes.ts", "../../outside/secret")).toEqual({
      kind: "escape",
    });
    expect(resolveImport(repo, "src/routes.ts", "./controllers/user")).toEqual({
      kind: "ok",
      path: "src/controllers/user.ts",
    });
    expect(resolveImport(repo, "src/routes.ts", "hono")).toEqual({ kind: "external" });
    expect(resolveImport(repo, "src/routes.ts", "./missing-module")).toEqual({ kind: "not-found" });
  });

  it("never walks into ignored directories", () => {
    const files = walkRepository(repo.rootPath);
    expect(
      files.some((f) => f.includes("node_modules") || f.includes("/dist/") || f.includes(".git/")),
    ).toBe(false);
    expect(files.every((f) => !f.startsWith(".."))).toBe(true);
  });

  it("rejects non-directory repository roots", () => {
    expect(() => makeRepositoryContext(`${repo.rootPath}/src/routes.ts`)).toThrow(
      /Not a directory/,
    );
  });
});
