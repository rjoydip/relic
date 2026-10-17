import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { GraphNode } from "@relic/graph-core";
import { openGraph, repositoryIdFor, type OpenGraph } from "@relic/indexer";
import { copyFixture, cleanup, tempDir } from "../helpers";

let fixture: { root: string; cleanup: () => void };
let dbDir: string;
let graph: OpenGraph;
let repoId: string;

const names = (nodes: GraphNode[]): string[] => nodes.map((n) => n.name);

beforeEach(() => {
  fixture = copyFixture();
  dbDir = tempDir();
  graph = openGraph(join(dbDir, "graph.db"));
  repoId = repositoryIdFor(fixture.root);
});

afterEach(async () => {
  graph.close();
  fixture.cleanup();
  await cleanup([dbDir]);
});

describe("repository indexing — critical fixture scenario", () => {
  it("indexes a TypeScript repository from scratch", () => {
    const result = graph.indexer.index(fixture.root);
    expect(result.repositoryId).toBe(repoId);
    expect(result.totalFiles).toBeGreaterThanOrEqual(9);
    expect(result.analyzedFiles).toBe(result.totalFiles);
    expect(result.nodeCount).toBeGreaterThan(15);
    expect(result.edgeCount).toBeGreaterThan(15);
    expect(result.revision).toBeNull(); // fixture is not a git repo

    const summary = graph.graph.getSummary(repoId);
    expect(summary.fileCount).toBe(result.totalFiles);
    expect(summary.indexedAt).not.toBeNull();
  });

  it("answers the updateUser() impact question with evidence and confidence", () => {
    graph.indexer.index(fixture.root);
    const target = graph.graph
      .searchSymbols(repoId, "UserService.updateUser")
      .find((n) => n.qualifiedName === "UserService.updateUser")!;
    expect(target).toBeDefined();

    const impact = graph.graph.analyzeImpact(repoId, target.id, {
      maxDepth: 5,
      includeTests: true,
      includeIndirect: true,
    });
    const affectedIds = impact.affected.map((a) => a.node.qualifiedName);

    // Direct caller: UserController.updateUser
    const controller = impact.affected.find(
      (a) => a.node.qualifiedName === "UserController.updateUser",
    );
    expect(controller).toBeDefined();
    expect(controller!.depth).toBe(1);
    expect(controller!.relationship).toBe("CALLS");
    expect(controller!.confidence).toBeCloseTo(0.6);
    expect(controller!.evidence.file).toBe("src/controllers/user.ts");
    expect(controller!.evidence.line).toBeGreaterThan(0);

    // Repository relationship (indirect: target's own dependency)
    expect(affectedIds).toContain("UserRepository.update");

    // Route, GraphQL resolver, WebSocket action
    expect(affectedIds).toContain("PATCH /users/:id");
    expect(affectedIds).toContain("Mutation.updateUser");
    expect(affectedIds).toContain("ws:user:update");

    // Tests
    expect(impact.summary.affectedTests).toBeGreaterThanOrEqual(1);
    const tests = impact.affected.filter((a) => a.node.type === "test").map((a) => a.node.name);
    expect(tests.some((t) => t.includes("user.service.test.ts"))).toBe(true);

    // Unrelated symbols are excluded
    expect(affectedIds).not.toContain("defineMutation");
    expect(affectedIds).not.toContain("UserRepository.query"); // only reached through update's internals, not via reverse edges from updateUser

    // Database dependency via WRITES
    const tables = graph.graph.searchSymbols(repoId, "users", "database_table");
    expect(tables.length).toBe(1);
    const repoWrites = graph.repository.getEdges({
      sourceIds: [graph.graph.searchSymbols(repoId, "UserRepository.update")[0]!.id],
      edgeTypes: ["WRITES"],
    });
    expect(repoWrites).toHaveLength(1);
    expect(repoWrites[0]!.confidence).toBe(1);
    expect(repoWrites[0]!.evidence.note).toContain("UPDATE users");
  });

  it("routes expose handlers and frontend operations map to routes", () => {
    graph.indexer.index(fixture.root);
    const route = graph.graph.searchSymbols(repoId, "PATCH /users/:id", "route")[0]!;
    const exposed = graph.repository.getEdges({ sourceIds: [route.id], edgeTypes: ["EXPOSES"] });
    expect(exposed).toHaveLength(1);
    const handler = graph.repository.getNode(exposed[0]!.targetId);
    expect(handler?.qualifiedName).toBe("UserController.updateUser");

    const mutation = graph.graph.searchSymbols(
      repoId,
      "updateUserMutation",
      "frontend_operation",
    )[0]!;
    const uses = graph.repository.getEdges({
      sourceIds: [mutation.id],
      edgeTypes: ["USES_OPERATION"],
    });
    expect(uses).toHaveLength(1);
    expect(uses[0]!.targetId).toBe(route.id);
    expect(uses[0]!.confidence).toBeCloseTo(0.6);
  });

  it("finds related tests directly and through callers", () => {
    graph.indexer.index(fixture.root);
    const target = graph.graph
      .searchSymbols(repoId, "UserService.updateUser")
      .find((n) => n.qualifiedName === "UserService.updateUser")!;
    const tests = graph.graph.findRelatedTests(repoId, target.id);
    const testNames = names(tests);
    expect(testNames.some((n) => n.includes("user.service.test.ts"))).toBe(true);
    expect(testNames.some((n) => n.includes("user.integration.test.ts"))).toBe(true);
  });

  it("explains how two components connect", () => {
    graph.indexer.index(fixture.root);
    const from = graph.graph.searchSymbols(repoId, "routes.ts", "file")[0]!;
    const to = graph.graph
      .searchSymbols(repoId, "UserRepository.update")
      .find((n) => n.qualifiedName === "UserRepository.update")!;
    const path = graph.graph.getDependencyPath(repoId, from.id, to.id);
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]?.node.id).toBe(to.id);
  });
});

describe("incremental indexing", () => {
  it("re-analyzes only changed files and their importers", () => {
    const first = graph.indexer.index(fixture.root);
    expect(first.analyzedFiles).toBe(first.totalFiles);

    appendFileSync(
      join(fixture.root, "src/services/user.ts"),
      "\nexport const extraHelper = (): void => {};\n",
    );
    const second = graph.indexer.index(fixture.root);
    expect(second.totalFiles).toBe(first.totalFiles);
    expect(second.analyzedFiles).toBeGreaterThan(1);
    expect(second.analyzedFiles).toBeLessThan(first.totalFiles);

    const helper = graph.graph.searchSymbols(repoId, "extraHelper");
    expect(helper).toHaveLength(1);
    // Existing relationships survive incremental updates.
    const target = graph.graph
      .searchSymbols(repoId, "UserService.updateUser")
      .find((n) => n.qualifiedName === "UserService.updateUser")!;
    const callers = graph.graph.findDependents(repoId, target.id, 2);
    expect(callers.map((n) => n.qualifiedName)).toContain("UserController.updateUser");
  });

  it("stale edges disappear when a call site changes", () => {
    graph.indexer.index(fixture.root);
    const query = graph.graph.searchSymbols(repoId, "UserRepository.query")[0]!;
    const caller = graph.graph.searchSymbols(repoId, "UserRepository.update")[0]!;
    expect(
      graph.repository
        .getEdges({ sourceIds: [caller.id], edgeTypes: ["CALLS"] })
        .map((e) => e.targetId),
    ).toContain(query.id);

    // Remove the call site; the declaration stays.
    const file = join(fixture.root, "src/repositories/user.ts");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        'await this.query("UPDATE users SET name = ? WHERE id = ?", [data["name"], id]);',
        "void id; void data;",
      ),
    );
    graph.indexer.index(fixture.root);

    expect(
      graph.repository
        .getEdges({ sourceIds: [caller.id], edgeTypes: ["CALLS"] })
        .map((e) => e.targetId),
    ).not.toContain(query.id);
    // Declaration still exists (only the edge went stale).
    expect(graph.graph.searchSymbols(repoId, "UserRepository.query")).toHaveLength(1);
    // And SQL writes now attach to update's replacement body — table edge gone.
    const writes = graph.repository.getEdges({ edgeTypes: ["WRITES"], limit: 500 });
    expect(writes).toHaveLength(0);
  });

  it("deletes graph records for deleted files", () => {
    graph.indexer.index(fixture.root);
    const before = graph.graph.getSummary(repoId).counts;
    rmSync(join(fixture.root, "src/repositories/user.ts"));

    const result = graph.indexer.index(fixture.root);
    expect(result.deletedFiles).toBe(1);

    const repoUpdate = graph.graph.searchSymbols(repoId, "UserRepository.update");
    expect(repoUpdate).toHaveLength(0);
    const tableNodes = graph.graph.searchSymbols(repoId, "users", "database_table");
    expect(tableNodes).toHaveLength(0); // orphan pruned after its file died
    expect(graph.graph.getSummary(repoId).counts.nodes).toBeLessThan(before.nodes);
    // Importer (services/user.ts) re-analyzed and now reports the unresolved import.
    const meta = graph.graph.getSummary(repoId);
    expect(
      meta.diagnostics.some(
        (d) => d.kind === "unresolved" && d.message.includes("repositories/user"),
      ),
    ).toBe(true);
    // No edges to the deleted node survive.
    const target = graph.graph
      .searchSymbols(repoId, "UserService.updateUser")
      .find((n) => n.qualifiedName === "UserService.updateUser")!;
    const deps = graph.graph.findDependencies(repoId, target.id, 2);
    expect(deps.map((n) => n.qualifiedName)).not.toContain("UserRepository.update");
  });
});
