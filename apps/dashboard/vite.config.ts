import { ServerResponse } from "node:http";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        configure: (proxy) => {
          proxy.on("error", (_err, _req, res) => {
            // A dead dev API otherwise surfaces as a bodyless 500 ("Request
            // failed (500)"); answer with something the UI can explain.
            if (res instanceof ServerResponse && !res.headersSent) {
              res.writeHead(503, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "API_UNAVAILABLE",
                  message:
                    "Graph API is not running at 127.0.0.1:8787 — start it with `bun run dev:api`, or run `mcpdg` for the bundled dashboard.",
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
