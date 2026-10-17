import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { repositoryIdFor } from "@relic/indexer";
import { buildApp, parseGitHubUrl } from "../../apps/api/src/app";
import { cleanup, copyFixture, FIXTURE_ROOT, json, tempDir } from "../helpers";

let fixture: { root: string; cleanup: () => void };
let dbDir: string;
let app: ReturnType<typeof buildApp>;
let repoId: string;

beforeEach(async () => {
  fixture = copyFixture();
  dbDir = tempDir();
  app = buildApp({ dbPath: join(dbDir, "graph.db") });
  repoId = repositoryIdFor(fixture.root);
  const res = await app.request(`/api/repositories/${repoId}/index`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: fixture.root }),
  });
  expect(res.status).toBe(200);
});

afterEach(async () => {
  app.graph.close();
  fixture.cleanup();
  await cleanup([dbDir]);
});

describe("dashboard API", () => {
  it("lists repositories and returns summaries", async () => {
    const list = await json<{ repositories: Array<{ id: string }> }>(
      await app.request("/api/repositories"),
    );
    expect(list.repositories.map((r) => r.id)).toContain(repoId);

    const summary = await json<{ counts: { nodes: number } }>(
      await app.request(`/api/repositories/${repoId}/summary`),
    );
    expect(summary.counts.nodes).toBeGreaterThan(15);
  });

  it("queries nodes with filters and pagination caps", async () => {
    const nodes = await json<{ nodes: Array<{ name: string }> }>(
      await app.request(`/api/graph/nodes?repository=${repoId}&type=symbol&q=updateUser`),
    );
    expect(nodes.nodes.length).toBeGreaterThan(0);
    expect(nodes.nodes.every((n) => n.name.includes("updateUser"))).toBe(true);

    const capped = await json<{ nodes: unknown[] }>(
      await app.request(`/api/graph/nodes?repository=${repoId}&limit=99999`),
    );
    expect(capped.nodes.length).toBeLessThanOrEqual(500);
    const all = await json<{ nodes: unknown[] }>(
      await app.request(`/api/graph/nodes?repository=${repoId}&limit=500`),
    );
    expect(capped.nodes.length).toBe(all.nodes.length);
    expect(all.nodes.length).toBeGreaterThan(0);
  });

  it("returns node details and bounded neighborhoods", async () => {
    const found = await json<{ nodes: Array<{ id: string }> }>(
      await app.request(`/api/graph/nodes?repository=${repoId}&q=UserService.updateUser`),
    );
    const target = found.nodes.find((n) => n.id)!.id;

    const node = await json<{ qualifiedName: string }>(
      await app.request(`/api/graph/nodes/${target}`),
    );
    expect(node.qualifiedName).toBe("UserService.updateUser");

    const hood = await json<{ nodes: Array<{ id: string }>; steps: Array<{ depth: number }> }>(
      await app.request(`/api/graph/nodes/${target}/neighborhood?depth=2`),
    );
    expect(hood.nodes.length).toBeGreaterThan(1);
    expect(hood.steps.some((s) => s.depth === 1)).toBe(true);

    const missing = await app.request("/api/graph/nodes/does-not-exist");
    expect(missing.status).toBe(404);
  });

  it("serves repository file content and blocks escapes", async () => {
    const nodes = await json<{ nodes: Array<{ filePath: string | null }> }>(
      await app.request(`/api/graph/nodes?repository=${repoId}&limit=5`),
    );
    const path = nodes.nodes.find((n) => n.filePath)!.filePath!;

    const file = await json<{ content: string }>(
      await app.request(`/api/repositories/${repoId}/file?path=${encodeURIComponent(path)}`),
    );
    expect(file.content.length).toBeGreaterThan(0);

    const escape = await app.request(
      `/api/repositories/${repoId}/file?path=${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(escape.status).toBe(400);

    const absent = await app.request(`/api/repositories/${repoId}/file?path=src/nope.ts`);
    expect(absent.status).toBe(400);
  });

  it("runs impact analysis consistent with the graph service", async () => {
    const res = await app.request("/api/impact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: repoId,
        symbol: "UserService.updateUser",
        maxDepth: 5,
        includeTests: true,
      }),
    });
    expect(res.status).toBe(200);
    const impact = await json<{
      affected: Array<{
        node: { qualifiedName: string | null };
        depth: number;
        relationship: string;
      }>;
      summary: { affectedTests: number };
    }>(res);
    const qualified = impact.affected.map((a) => a.node.qualifiedName);
    expect(qualified).toContain("UserController.updateUser");
    expect(qualified).toContain("Mutation.updateUser");
    expect(qualified).toContain("ws:user:update");
    expect(qualified).toContain("PATCH /users/:id");
    expect(impact.summary.affectedTests).toBeGreaterThanOrEqual(1);
  });

  it("serves edges, related tests, and index status", async () => {
    const edges = await json<{ edges: Array<{ type: string; repositoryId: string }> }>(
      await app.request(`/api/graph/edges?repository=${repoId}&types=CALLS&limit=500`),
    );
    expect(edges.edges.length).toBeGreaterThan(0);
    expect(edges.edges.every((e) => e.type === "CALLS" && e.repositoryId === repoId)).toBe(true);

    const tests = await json<{ tests: Array<{ name: string }> }>(
      await app.request(`/api/tests/related?repository=${repoId}&symbol=UserService.updateUser`),
    );
    expect(tests.tests.some((t) => t.name.includes("user.service.test.ts"))).toBe(true);

    const status = await json<{ fileCount: number; indexedAt: string }>(
      await app.request(`/api/index-status?repository=${repoId}`),
    );
    expect(status.fileCount).toBeGreaterThanOrEqual(9);
    expect(status.indexedAt).toBeTruthy();
  });

  it("rejects unknown repositories and invalid input with stable codes", async () => {
    const missing = await app.request("/api/repositories/nope/summary");
    expect(missing.status).toBe(404);
    expect((await json<{ error: string }>(missing)).error).toBe("REPOSITORY_NOT_FOUND");

    const bad = await app.request("/api/impact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: repoId, symbol: "NoSuchThing" }),
    });
    expect(bad.status).toBe(400);
    expect((await json<{ error: string }>(bad)).error).toBe("INVALID_INPUT");
  });

  it("maps guarded-route lookups to stable 404s", async () => {
    const edges = await app.request("/api/graph/edges?repository=not-a-repo");
    expect(edges.status).toBe(404);
    expect((await json<{ error: string }>(edges)).error).toBe("REPOSITORY_NOT_FOUND");

    const hood = await app.request("/api/graph/nodes/does-not-exist/neighborhood");
    expect(hood.status).toBe(404);
    expect((await json<{ error: string }>(hood)).error).toBe("NODE_NOT_FOUND");

    const status = await app.request("/api/index-status?repository=not-a-repo");
    expect(status.status).toBe(404);
    expect((await json<{ error: string }>(status)).error).toBe("REPOSITORY_NOT_FOUND");
  });

  it("rejects rootless indexing, unknown related-test symbols, and ambiguous symbols", async () => {
    const noRoot = await app.request("/api/repositories/not-indexed/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noRoot.status).toBe(400);
    expect((await json<{ error: string }>(noRoot)).error).toBe("INVALID_INPUT");

    const related = await app.request(`/api/tests/related?repository=${repoId}&symbol=NoSuchThing`);
    expect(related.status).toBe(400);
    expect((await json<{ error: string }>(related)).error).toBe("INVALID_INPUT");

    const ambiguous = await app.request("/api/impact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: repoId, symbol: "User" }),
    });
    expect(ambiguous.status).toBe(400);
    const body = await json<{ error: string; message: string }>(ambiguous);
    expect(body.error).toBe("INVALID_INPUT");
    expect(body.message).toContain("Ambiguous symbol: User");
  });
});

describe("dashboard API — allowed roots", () => {
  it("rejects repository paths outside configured roots", async () => {
    const scoped = buildApp({ dbPath: join(tempDir(), "scoped.db"), allowedRoots: [FIXTURE_ROOT] });
    const inside = await scoped.request(
      `/api/graph/nodes?repository=${encodeURIComponent(FIXTURE_ROOT)}&limit=1`,
    );
    expect(inside.status).toBe(200); // unindexed but inside the allowed root

    const outside = await scoped.request(
      `/api/graph/nodes?repository=${encodeURIComponent("C:\\windows\\system32")}&limit=1`,
    );
    expect(outside.status).toBe(400);
    const body = await json<{ error: string }>(outside);
    expect(body.error).toBe("PATH_ESCAPE");
    scoped.graph.close();
  });
});

describe("index source (paths and GitHub URLs)", () => {
  it("accepts GitHub URLs and rejects lookalikes", () => {
    expect(parseGitHubUrl("https://github.com/acme/widgets")).toBe(
      "https://github.com/acme/widgets",
    );
    expect(parseGitHubUrl(" https://github.com/acme/widgets.git/ ")).toBe(
      "https://github.com/acme/widgets",
    );
    expect(parseGitHubUrl("http://github.com/acme/widgets")).toBeNull();
    expect(parseGitHubUrl("https://gitlab.com/acme/widgets")).toBeNull();
    expect(parseGitHubUrl("git@github.com:acme/widgets.git")).toBeNull();
    expect(parseGitHubUrl("https://github.com/acme/../widgets")).toBeNull();
    expect(parseGitHubUrl("https://evil.com/github.com/acme/widgets")).toBeNull();
  });

  it("indexes a local path through POST /api/index", async () => {
    const res = await app.request("/api/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: fixture.root }),
    });
    expect(res.status).toBe(200);
    const result = await json<{ repositoryId: string; nodeCount: number; analyzedFiles: number }>(
      res,
    );
    expect(result.repositoryId).toBe(repoId);
    expect(result.nodeCount).toBeGreaterThan(15);
  });

  it("validates sources and enforces allowed roots", async () => {
    const empty = await app.request("/api/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    expect((await json<{ error: string }>(empty)).error).toBe("INVALID_INPUT");

    const scoped = buildApp({ dbPath: join(tempDir(), "scoped.db"), allowedRoots: [FIXTURE_ROOT] });
    const outside = await scoped.request("/api/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "C:\\windows\\system32" }),
    });
    expect(outside.status).toBe(400);
    expect((await json<{ error: string }>(outside)).error).toBe("PATH_ESCAPE");

    const github = await scoped.request("/api/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://github.com/acme/widgets" }),
    });
    expect(github.status).toBe(400);
    expect((await json<{ error: string }>(github)).error).toBe("PATH_ESCAPE");
    scoped.graph.close();
  });
});
