import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  makeRepositoryContext,
  relate,
  walkRepository,
  type RefInfo,
  type RefLookup,
} from "@relic/analyzer-core";
import { extractPythonFile } from "@relic/analyzer-python";
import { ANALYZER_FIXTURES } from "../../helpers";

const root = join(ANALYZER_FIXTURES, "python", "python-service");
const repo = makeRepositoryContext(root);
const paths = walkRepository(root);
const files = paths.map((path) => extractPythonFile(repo, path));

function lookupFrom(all: RefInfo[]): RefLookup {
  return {
    findByName: (name) =>
      all.filter(
        (r) => r.name === name || r.qualifiedName === name || r.qualifiedName.endsWith(`.${name}`),
      ),
  };
}

const lookup = lookupFrom(files.flatMap((file) => file.refs));
const edges = files.flatMap((file) => relate(repo, file, lookup).edges);

describe("Python analyzer", () => {
  it("extracts symbols with class-qualified names", () => {
    const names = files.flatMap((file) => file.declarations).map((d) => d.qualifiedName);
    expect(names).toContain("UserService.update_user");
    expect(names).toContain("UserRepository.update");
    expect(names).toContain("update_user");
  });

  it("resolves imports, calls, routes, SQL and tests", () => {
    const node = (name: string) => files.flatMap((file) => file.nodes).find((n) => n.name === name);
    const service = node("UserService")!;
    const route = files
      .flatMap((file) => file.nodes)
      .find((n) => n.type === "route" && n.qualifiedName === "GET /users/{user_id}");
    expect(route).toBeDefined();

    const exposes = edges.filter((e) => e.type === "EXPOSES");
    expect(exposes.some((e) => e.targetId === service.id)).toBe(false);
    expect(exposes.some((e) => e.sourceId === route!.id)).toBe(true);

    const calls = edges.filter((e) => e.type === "CALLS");
    const update = files
      .flatMap((file) => file.nodes)
      .find((n) => n.qualifiedName === "UserService.update_user")!;
    expect(calls.some((e) => e.targetId === update.id)).toBe(true);

    const writes = edges.filter((e) => e.type === "WRITES");
    expect(writes).toHaveLength(1);

    const tests = edges.filter((e) => e.type === "TESTS");
    expect(tests.length).toBeGreaterThan(0);
  });

  it("does not treat Python files as TypeScript", () => {
    expect(paths.every((path) => path.endsWith(".py"))).toBe(true);
    const diagnostics = files.flatMap((file) => file.diagnostics);
    expect(diagnostics.some((d) => d.kind === "parse-error")).toBe(false);
  });

  it("covers websocket, multi-method, Django and queue extraction", () => {
    const nodes = files.flatMap((file) => file.nodes);
    const qualified = nodes.map((node) => node.qualifiedName);
    expect(qualified).toContain("ws:/ws/events");
    expect(qualified).toContain("POST /events");
    expect(qualified).toContain("PUT /events");
    expect(qualified).toContain("ANY items/:id");
    expect(qualified.filter((name) => name?.startsWith("ANY ^old/"))).toHaveLength(1);

    const queues = nodes.filter((node) => node.type === "queue").map((node) => node.name);
    expect(queues).toContain("events");
    const queueEdges = edges.filter((e) => e.type === "PUBLISHES" || e.type === "CONSUMES");
    expect(queueEdges.map((e) => e.type).sort()).toEqual(["CONSUMES", "PUBLISHES"]);

    const reads = edges.filter((edge) => edge.type === "READS");
    expect(reads).toHaveLength(1);

    const unresolved = files.flatMap((file) => file.diagnostics);
    expect(unresolved.some((d) => d.message.includes("missing.module"))).toBe(true);
  });
});
