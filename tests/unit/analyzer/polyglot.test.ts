import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  makeRepositoryContext,
  relate,
  walkRepository,
  type ExtractedFile,
  type RefInfo,
  type RefLookup,
} from "@relic/analyzer-core";
import { extractGoFile } from "@relic/analyzer-go";
import { extractJavaFile } from "@relic/analyzer-java";
import { extractRustFile } from "@relic/analyzer-rust";
import { ANALYZER_FIXTURES } from "../../helpers";

const polyglot = ANALYZER_FIXTURES;

function extractAll(
  root: string,
  extract: (repo: ReturnType<typeof makeRepositoryContext>, path: string) => ExtractedFile,
) {
  const repo = makeRepositoryContext(root);
  const files = walkRepository(root).map((path) => extract(repo, path));
  const allRefs: RefInfo[] = files.flatMap((file) => file.refs);
  const lookup: RefLookup = {
    findByName: (name) =>
      allRefs.filter(
        (ref) =>
          ref.name === name || ref.qualifiedName === name || ref.qualifiedName.endsWith(`.${name}`),
      ),
  };
  const edges = files.flatMap((file) => relate(repo, file, lookup).edges);
  return { repo, files, edges };
}

const names = (files: ExtractedFile[]) => files.flatMap((file) => file.nodes);

describe("Go analyzer", () => {
  const root = join(polyglot, "go");
  const { files, edges } = extractAll(root, extractGoFile);

  it("extracts types, methods, routes and tests", () => {
    const nodes = names(files);
    expect(nodes.map((node) => node.qualifiedName)).toContain("Repo.Update");
    expect(nodes.some((node) => node.type === "test")).toBe(true);
    const routes = nodes.filter((node) => node.type === "route").map((node) => node.qualifiedName);
    expect(routes).toEqual(
      expect.arrayContaining(["GET /users/:id", "POST /users", "ANY /health"]),
    );
  });

  it("resolves local packages and keeps external imports external", () => {
    const imports = files.flatMap((file) => file.imports);
    expect(imports.some((i) => i.specifier === "example/repo" && i.targetFile)).toBe(true);
    expect(imports.some((i) => i.specifier === "fmt" && i.targetFile === null)).toBe(true);
  });

  it("records SQL, queues and cross-file calls", () => {
    expect(edges.some((e) => e.type === "READS" && e.evidence.note?.includes("audit_log"))).toBe(
      true,
    );
    expect(edges.some((e) => e.type === "WRITES")).toBe(true);
    expect(edges.some((e) => e.type === "PUBLISHES")).toBe(true);
    expect(edges.some((e) => e.type === "CONSUMES")).toBe(true);
    expect(edges.some((e) => e.type === "CALLS")).toBe(true);
  });
});

describe("Java analyzer", () => {
  const root = join(polyglot, "java");
  const { files, edges } = extractAll(root, extractJavaFile);

  it("extracts classes, methods and Spring routes", () => {
    const nodes = names(files);
    const qualified = nodes.map((node) => node.qualifiedName);
    expect(qualified).toContain("UserController");
    expect(qualified).toContain("UserController.getUser");
    expect(qualified).toContain("GET /users/{id}");
    expect(qualified).toContain("POST /users");
    expect(qualified).toContain("ANY /legacy");
    expect(files.some((file) => file.isTest)).toBe(true);
  });

  it("resolves imports and emits SQL edges", () => {
    const imports = files.flatMap((file) => file.imports);
    expect(
      imports.some((i) => i.specifier === "com.example.UserRepository" && i.targetFile !== null),
    ).toBe(true);
    expect(edges.some((e) => e.type === "READS")).toBe(true);
    expect(edges.some((e) => e.type === "WRITES")).toBe(true);
  });
});

describe("Rust analyzer", () => {
  const root = join(polyglot, "rust");
  const { files, edges } = extractAll(root, extractRustFile);

  it("extracts structs, impl methods, actix and axum routes", () => {
    const nodes = names(files);
    const qualified = nodes.map((node) => node.qualifiedName);
    expect(qualified).toContain("Repo");
    expect(qualified).toContain("Repo.update");
    expect(qualified).toContain("GET /health");
    expect(qualified).toContain("GET /items");
    expect(files.some((file) => file.isTest)).toBe(true);
  });

  it("resolves crate modules and emits SQL and queue edges", () => {
    const imports = files.flatMap((file) => file.imports);
    expect(imports.some((i) => i.specifier === "crate::repo::Repo" && i.targetFile)).toBe(true);
    expect(edges.some((e) => e.type === "READS" || e.type === "WRITES")).toBe(true);
    expect(edges.some((e) => e.type === "PUBLISHES")).toBe(true);
    expect(edges.some((e) => e.type === "CONSUMES")).toBe(true);
  });
});
