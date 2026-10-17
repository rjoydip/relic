import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { repositoryIdFor } from "@skein/indexer";
import { buildApp } from "../../apps/api/src/app";
import { cleanup, copyFixture, json, tempDir } from "../helpers";

let fixture: { root: string; cleanup: () => void };
let dbDir: string;
let app: ReturnType<typeof buildApp>;
let repoId: string;

beforeEach(async () => {
  fixture = copyFixture();
  dbDir = tempDir();
  app = buildApp({ dbPath: join(dbDir, "graph.db") });
  repoId = repositoryIdFor(fixture.root);
  await app.request(`/api/repositories/${repoId}/index`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: fixture.root }),
  });
});

afterEach(async () => {
  app.graph.close();
  fixture.cleanup();
  await cleanup([dbDir]);
});

describe("unsafe inputs", () => {
  it("treats SQL injection attempts as plain text queries", async () => {
    const payload = "' OR 1=1; DROP TABLE nodes; --";
    const res = await app.request(
      `/api/graph/nodes?repository=${repoId}&q=${encodeURIComponent(payload)}`,
    );
    expect(res.status).toBe(200);
    const body = await json<{ nodes: unknown[] }>(res);
    expect(body.nodes).toHaveLength(0);
    // Table still exists — parameterized queries only.
    const ok = await app.request(`/api/graph/nodes?repository=${repoId}&limit=1`);
    expect(ok.status).toBe(200);
  });

  it("caps hostile limit values and ignores garbage offsets", async () => {
    for (const qs of [
      "limit=0",
      "limit=-5",
      "limit=abc",
      "limit=1e30",
      "offset=-100",
      "offset=NaN",
    ]) {
      const res = await app.request(`/api/graph/nodes?repository=${repoId}&${qs}`);
      expect(res.status).toBe(200);
      const body = await json<{ nodes: unknown[] }>(res);
      expect(body.nodes.length).toBeLessThanOrEqual(500);
    }
  });

  it("rejects unknown node types instead of interpolating them", async () => {
    const res = await app.request(
      `/api/graph/nodes?repository=${repoId}&type=${encodeURIComponent("symbol; DROP TABLE nodes")}`,
    );
    expect(res.status).toBe(200);
    const body = await json<{ nodes: unknown[] }>(res);
    expect(body.nodes).toHaveLength(0);
  });

  it("validates impact payloads", async () => {
    const noSymbol = await app.request("/api/impact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: repoId }),
    });
    expect(noSymbol.status).toBe(400);

    const malformed = await app.request("/api/impact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
  });

  it("indexing never writes into the indexed repository", async () => {
    const before = (await import("node:fs")).readdirSync(fixture.root).sort();
    await app.request(`/api/repositories/${repoId}/index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: fixture.root }),
    });
    const after = (await import("node:fs")).readdirSync(fixture.root).sort();
    expect(after).toEqual(before);
  });
});
