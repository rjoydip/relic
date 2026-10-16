import { describe, expect, it } from "bun:test";
import { makeRepositoryContext, walkRepository } from "@mcpdg/analyzer-typescript";
import { extractFile, relate, type RefInfo, type RefLookup } from "@mcpdg/analyzer-typescript";
import { FIXTURE_ROOT } from "../../helpers";

const repo = makeRepositoryContext(FIXTURE_ROOT);

function lookupFrom(all: RefInfo[]): RefLookup {
  return {
    findByName: (name) =>
      all.filter(
        (r) => r.name === name || r.qualifiedName === name || r.qualifiedName.endsWith(`.${name}`),
      ),
  };
}

describe("TypeScriptAnalyzer extraction", () => {
  it("extracts declarations with stable symbol identities", () => {
    const extracted = extractFile(repo, "src/services/user.ts");
    const qns = extracted.declarations.map((d) => d.qualifiedName);
    expect(qns).toContain("UserService");
    expect(qns).toContain("UserService.updateUser");
    expect(qns).toContain("userService");
    const service = extracted.declarations.find(
      (d) => d.qualifiedName === "UserService.updateUser",
    );
    expect(service?.startLine).toBeGreaterThan(0);
    expect(service!.endLine).toBeGreaterThanOrEqual(service!.startLine);
    // Identity ignores line numbers: same file+name yields same id on re-extract.
    expect(
      extractFile(repo, "src/services/user.ts").declarations.find(
        (d) => d.qualifiedName === "UserService.updateUser",
      )?.id,
    ).toBe(service?.id);
  });

  it("records import bindings and detects unresolved relative imports", () => {
    const extracted = extractFile(repo, "src/controllers/user.ts");
    const binding = extracted.imports.find((i) => i.localName === "userService");
    expect(binding?.targetFile).toBe("src/services/user.ts");
    expect(binding?.exportName).toBe("userService");
    // inline type-only specifier must not become a runtime import
    expect(extracted.imports.find((i) => i.localName === "UserUpdate")).toBeUndefined();
    expect(extracted.diagnostics.filter((d) => d.kind === "unresolved")).toHaveLength(0);
  });

  it("detects routes, graphql operations, websocket actions, and frontend mutations", () => {
    const routes = extractFile(repo, "src/routes.ts");
    const route = routes.nodes.find((n) => n.type === "route" && n.name === "PATCH /users/:id");
    expect(route).toBeDefined();
    expect(
      routes.handlers.some((h) => h.ref.kind === "property" && h.ref.propName === "updateUser"),
    ).toBe(true);
    // inline handler: no identifier to resolve
    expect(routes.handlers.some((h) => h.ref.kind === "inline")).toBe(true);

    const graphql = extractFile(repo, "src/api/graphql.ts");
    expect(
      graphql.nodes.some((n) => n.type === "api_operation" && n.name === "Mutation.updateUser"),
    ).toBe(true);

    const ws = extractFile(repo, "src/api/websocket.ts");
    expect(ws.nodes.some((n) => n.type === "api_operation" && n.name === "ws:user:update")).toBe(
      true,
    );

    const fe = extractFile(repo, "src/frontend/mutations.ts");
    expect(fe.frontend).toHaveLength(1);
    expect(fe.frontend[0]).toMatchObject({ method: "PATCH", path: "/users/:id" });
  });

  it("extracts SQL statements as READS/WRITES with the target table", () => {
    const extracted = extractFile(repo, "src/repositories/user.ts");
    expect(extracted.sql).toHaveLength(1);
    expect(extracted.sql[0]).toMatchObject({ table: "users", mode: "WRITES" });
    expect(extracted.sql[0]?.excerpt).toContain("UPDATE users");
  });

  it("classifies test files", () => {
    expect(extractFile(repo, "tests/user.service.test.ts").isTest).toBe(true);
    expect(extractFile(repo, "src/routes.ts").isTest).toBe(false);
  });
});

describe("relationship resolution (pass 2)", () => {
  const files = walkRepository(repo.rootPath).map((p) => extractFile(repo, p));
  const allRefs = files.flatMap((f) => f.refs);
  const lookup = lookupFrom(allRefs);

  it("resolves cross-file property calls with inferred confidence", () => {
    const controller = files.find((f) => f.filePath === "src/controllers/user.ts")!;
    const { edges } = relate(repo, controller, lookup);
    const calls = edges.filter((e) => e.type === "CALLS");
    const serviceId = files
      .find((f) => f.filePath === "src/services/user.ts")!
      .declarations.find((d) => d.qualifiedName === "UserService.updateUser")!.id;
    const edge = calls.find((e) => e.targetId === serviceId);
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBeCloseTo(0.6);
    expect(edge!.evidence.source).toBe("inferred");
    expect(edge!.evidence.file).toBe("src/controllers/user.ts");
    expect(edge!.evidence.line).toBeGreaterThan(0);
  });

  it("emits EXPOSES from route to controller method", () => {
    const routes = files.find((f) => f.filePath === "src/routes.ts")!;
    const { edges } = relate(repo, routes, lookup);
    const exposes = edges.filter((e) => e.type === "EXPOSES");
    const controllerId = files
      .find((f) => f.filePath === "src/controllers/user.ts")!
      .declarations.find((d) => d.qualifiedName === "UserController.updateUser")!.id;
    expect(exposes.map((e) => e.targetId)).toContain(controllerId);
  });

  it("emits TESTS edges from test files to imported symbols", () => {
    const testFile = files.find((f) => f.filePath === "tests/user.service.test.ts")!;
    const { edges } = relate(repo, testFile, lookup);
    const tests = edges.filter((e) => e.type === "TESTS");
    const target = files
      .find((f) => f.filePath === "src/services/user.ts")!
      .declarations.find((d) => d.qualifiedName === "UserService.updateUser")!.id;
    expect(tests.map((e) => e.targetId)).toContain(target);
    expect(tests.every((e) => e.confidence === 1)).toBe(true);
  });

  it("maps frontend mutations to routes through endpoint metadata", () => {
    const fe = files.find((f) => f.filePath === "src/frontend/mutations.ts")!;
    const { edges } = relate(repo, fe, lookup);
    const uses = edges.find((e) => e.type === "USES_OPERATION");
    expect(uses).toBeDefined();
    expect(uses!.confidence).toBeCloseTo(0.6);
    expect(uses!.evidence.note).toContain("PATCH /users/:id");
  });

  it("reports unresolved calls instead of inventing relationships", () => {
    const extracted = extractFile(repo, "src/services/user.ts");
    extracted.imports.push({
      localName: "ghost",
      targetFile: "src/controllers/user.ts",
      exportName: "ghost",
    });
    extracted.calls.push({
      sourceId: extracted.declarations[0]!.id,
      line: 1,
      kind: "identifier",
      name: "ghost",
    });
    const { edges, diagnostics } = relate(repo, extracted, lookup);
    expect(edges.some((e) => e.targetId.includes("ghost"))).toBe(false);
    expect(diagnostics.some((d) => d.kind === "unresolved" && d.message.includes("ghost"))).toBe(
      true,
    );
  });

  it("resolves identifier handlers to local declarations, imports, or a diagnostic", () => {
    const service = extractFile(repo, "src/services/user.ts");
    const decl = service.declarations.find((d) => d.qualifiedName === "UserService.updateUser")!;
    service.handlers.push(
      { containerId: "route-local", ref: { kind: "identifier", name: "updateUser" }, line: 1 },
      {
        containerId: "route-missing",
        ref: { kind: "identifier", name: "missingHandler" },
        line: 2,
      },
    );
    const local = relate(repo, service, lookup);
    expect(
      local.edges.some((e) => e.type === "EXPOSES" && e.targetId === decl.id && e.confidence === 1),
    ).toBe(true);
    expect(
      local.diagnostics.some(
        (d) => d.kind === "unresolved" && d.message.includes("missingHandler"),
      ),
    ).toBe(true);

    const routes = extractFile(repo, "src/routes.ts");
    routes.handlers.push({
      containerId: "route-binding",
      ref: { kind: "identifier", name: "userController" },
      line: 1,
    });
    const bound = relate(repo, routes, lookup);
    const controllerDecl = files
      .find((f) => f.filePath === "src/controllers/user.ts")!
      .declarations.find((d) => d.qualifiedName === "userController")!;
    expect(bound.edges.some((e) => e.type === "EXPOSES" && e.targetId === controllerDecl.id)).toBe(
      true,
    );
  });

  it("resolves local property handlers and reports unresolvable ones", () => {
    const service = extractFile(repo, "src/services/user.ts");
    const decl = service.declarations.find((d) => d.qualifiedName === "UserService.updateUser")!;
    service.handlers.push({
      containerId: "route-local-prop",
      ref: { kind: "property", exprName: "notImported", propName: "updateUser" },
      line: 1,
    });
    const local = relate(repo, service, lookup);
    expect(local.edges.some((e) => e.type === "EXPOSES" && e.targetId === decl.id)).toBe(true);

    const routes = extractFile(repo, "src/routes.ts");
    routes.handlers.push({
      containerId: "route-broken",
      ref: { kind: "property", exprName: "userController", propName: "doesNotExist" },
      line: 1,
    });
    const broken = relate(repo, routes, lookup);
    expect(
      broken.diagnostics.some(
        (d) => d.kind === "unresolved" && d.message.includes("userController.doesNotExist"),
      ),
    ).toBe(true);
  });

  it("reports property calls that cannot be resolved in the imported file", () => {
    const service = extractFile(repo, "src/services/user.ts");
    service.imports.push({
      localName: "ghostController",
      targetFile: "src/controllers/user.ts",
      exportName: "userController",
    });
    service.calls.push({
      sourceId: service.declarations[0]!.id,
      line: 1,
      kind: "property",
      exprName: "ghostController",
      propName: "doesNotExist",
    });
    const { diagnostics } = relate(repo, service, lookup);
    expect(
      diagnostics.some(
        (d) => d.kind === "unresolved" && d.message.includes("ghostController.doesNotExist"),
      ),
    ).toBe(true);
  });

  it("emits a computed route edge and diagnostic when the endpoint is not indexed", () => {
    const fe = extractFile(repo, "src/frontend/mutations.ts");
    fe.frontend.push({
      nodeId: "operation-unknown",
      method: "GET",
      path: "/definitely-not-routed",
      line: 1,
    });
    const { edges, diagnostics } = relate(repo, fe, lookup);
    expect(
      edges.some((e) => e.type === "USES_OPERATION" && e.sourceId === "operation-unknown"),
    ).toBe(true);
    expect(
      diagnostics.some(
        (d) => d.kind === "unresolved" && d.message === "No route for GET /definitely-not-routed",
      ),
    ).toBe(true);
  });
});
