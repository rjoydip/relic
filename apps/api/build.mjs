// Bundle the two published entries (dashboard CLI + MCP stdio server) into
// apps/api/dist. Workspace packages (@skein/*) get inlined; npm dependencies
// stay external and install with the package. Run from apps/api.
import { existsSync, cpSync, rmSync } from "node:fs";
import { build } from "esbuild";

if (!existsSync("../dashboard/dist")) {
  console.error("dashboard not built — run `vite build apps/dashboard` first");
  process.exit(1);
}

// wipe tsc's emit so the tarball ships only the bundles + dashboard assets
rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: { cli: "src/cli.ts", index: "../mcp-server/src/index.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node23",
  outdir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  // runtime deps of the published package — resolved from node_modules, not bundled
  external: ["typescript", "@modelcontextprotocol/sdk", "zod", "hono", "@hono/node-server"],
});

cpSync("../dashboard/dist", "dist/dashboard", { recursive: true });
console.log("bundled dist/cli.js + dist/index.js with dashboard assets");
