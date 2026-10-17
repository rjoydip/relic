import { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The e2e run points this at its own isolated API instance (see
// playwright.config.ts); the dev default stays the local dev API.
const apiTarget = process.env.RELIC_API_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        configure: (proxy) => {
          proxy.on("error", (_err, _req, res) => {
            // A dead dev API otherwise surfaces as a bodyless 500 ("Request
            // failed (500)"); answer with something the UI can explain.
            if (res instanceof ServerResponse && !res.headersSent) {
              res.writeHead(503, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "API_UNAVAILABLE",
                  message: `Graph API is not running at ${apiTarget} — start it with \`bun run dev:api\`, or run \`relic\` for the bundled dashboard.`,
                }),
              );
            }
          });
        },
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
