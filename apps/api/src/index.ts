import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "./app";

const dbPath = process.env.MCP_GRAPH_DB ?? join(tmpdir(), "mcpdg-graph.db");
const allowedRoots = process.env.MCPDG_ALLOWED_ROOTS
  ? process.env.MCPDG_ALLOWED_ROOTS.split(";").filter(Boolean)
  : undefined;
const port = Number(process.env.PORT ?? 8787);

const app = buildApp({ dbPath, ...(allowedRoots ? { allowedRoots } : {}) });

console.error(`mcp-dependency-graph API listening on http://127.0.0.1:${port}`);

Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
