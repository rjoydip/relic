import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

/**
 * One assets-only Worker serves both static sites:
 *   /       -> apps/dashboard/dist
 *   /docs/  -> apps/dashboard/dist/docs (VitePress builds into it)
 *
 * The API is not deployed here: it needs node:sqlite, child processes and
 * filesystem access, so it stays a local-first process. See docs/index.md.
 */
export default Alchemy.Stack(
  "Relic",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Worker("Site", {
      name: "relic",
      assets: { directory: "./apps/dashboard/dist" },
    });
    return { url: site.url };
  }),
);
