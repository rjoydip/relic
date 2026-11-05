import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  blameRange,
  loadCodeowners,
  ownersFor,
  parseBlamePorcelain,
  parseCodeowners,
} from "@relic/analyzer-typescript";

const rules = parseCodeowners(`
# comment
* @relic/core
src/services/* @relic/services
src/repositories/* @relic/data
docs/ @relic/docs
*.md @relic/writers
!src/services/generated.ts @relic/generated
`);

describe("CODEOWNERS matching", () => {
  it("uses the last matching rule and any-level basename patterns", () => {
    expect(ownersFor(rules, "src/services/user.ts")).toEqual(["@relic/services"]);
    expect(ownersFor(rules, "src/repositories/user.ts")).toEqual(["@relic/data"]);
    expect(ownersFor(rules, "README.md")).toEqual(["@relic/writers"]);
    expect(ownersFor(rules, "docs/index.md")).toEqual(["@relic/writers"]);
    expect(ownersFor(rules, "src/cycle.ts")).toEqual(["@relic/core"]);
  });

  it("supports negation and directory patterns", () => {
    expect(ownersFor(rules, "src/services/generated.ts")).toEqual([]);
    expect(ownersFor(rules, "docs/guide/setup.md")).toEqual(["@relic/writers"]);
  });

  it("returns no owners when nothing matches", () => {
    expect(ownersFor(parseCodeowners("src/** @a"), "lib/x.ts")).toEqual([]);
  });
});

describe("git blame parsing", () => {
  it("summarises authors by blamed line", () => {
    const porcelain = [
      "abcdef1 1 1 1",
      "author Ada",
      "author-mail <ada@example.com>",
      "summary first",
      "\tconst a = 1;",
      "abcdef1 2 2",
      "author Ada",
      "author-mail <ada@example.com>",
      "summary first",
      "\tconst b = 2;",
      "1234567 3 3 1",
      "author Grace",
      "author-mail <grace@example.com>",
      "summary second",
      "\tconst c = 3;",
    ].join("\n");
    const result = parseBlamePorcelain(porcelain);
    expect(result.lineCount).toBe(3);
    expect(result.authors[0]).toMatchObject({
      name: "Ada",
      email: "ada@example.com",
      lines: 2,
    });
    expect(result.authors[1]).toMatchObject({ name: "Grace", lines: 1 });
  });
});

describe("CODEOWNERS loading and blame", () => {
  it("reads the first CODEOWNERS location and missing files return no rules", () => {
    const root = mkdtempSync(join(tmpdir(), "relic-owners-"));
    try {
      mkdirSync(join(root, ".github"), { recursive: true });
      writeFileSync(join(root, ".github", "CODEOWNERS"), "src/** @team\n");
      expect(loadCodeowners(root)).toEqual([
        { pattern: "src/**", owners: ["@team"], negated: false },
      ]);
      expect(loadCodeowners(join(root, "missing"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("summarises blame for a real git commit and returns null outside git", () => {
    const root = mkdtempSync(join(tmpdir(), "relic-blame-"));
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      writeFileSync(join(root, "a.ts"), "const a = 1;\nconst b = 2;\n");
      execFileSync("git", ["add", "."], { cwd: root, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "first"], { cwd: root, stdio: "pipe" });

      const blame = blameRange(root, "a.ts", 1, 2);
      expect(blame?.lineCount).toBe(2);
      expect(blame?.authors[0]?.name).toBe("Test");
      expect(blameRange(root, "missing.ts", 1, 2)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
