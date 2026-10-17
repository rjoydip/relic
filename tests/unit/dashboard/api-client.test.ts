import { afterEach, beforeEach, expect, test } from "bun:test";
import { api } from "../../../apps/dashboard/src/api";

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit | undefined }> = [];

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("nodes builds the filtered graph URL", async () => {
  mockFetch(() => Response.json({ nodes: [] }));
  await api.nodes("repo/1", "foo bar", "test");
  expect(calls[0]?.url).toBe(
    "/api/graph/nodes?repository=repo%2F1&limit=2000&q=foo%20bar&type=test",
  );
});

test("file content encodes the path", async () => {
  mockFetch(() => Response.json({ path: "a b.ts", content: "x" }));
  await api.fileContent("r 1", "src/a b.ts");
  expect(calls[0]?.url).toBe("/api/repositories/r%201/file?path=src%2Fa%20b.ts");
});

test("structured API errors surface code and message", async () => {
  mockFetch(() => Response.json({ error: "PATH_ESCAPE", message: "nope" }, { status: 400 }));
  await expect(api.fileContent("r", "../x")).rejects.toThrow("PATH_ESCAPE: nope");
});

test("non-JSON failures fall back to the status", async () => {
  mockFetch(() => new Response("boom", { status: 503 }));
  await expect(api.repositories()).rejects.toThrow("Request failed (503)");
});

test("reindex posts the repository root", async () => {
  mockFetch(() => Response.json({ analyzedFiles: 1, nodeCount: 0, edgeCount: 0 }));
  await api.reindex("r1", "/tmp/root");
  const call = calls[0]!;
  expect(call.init?.method).toBe("POST");
  expect(JSON.parse(String(call.init?.body))).toEqual({ root: "/tmp/root" });
});
