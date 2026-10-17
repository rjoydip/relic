import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Response.json() is Promise<unknown> under undici — cast once, here. */
export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(here, "..");
export const FIXTURE_ROOT = join(here, "fixtures", "starter-hono");

// ponytail: bun's node:sqlite releases file handles on a later event-loop
// turn, and Windows blocks rm until then — occasionally longer than any sane
// per-test wait (it raced bun's 5s hook timeout). All test scratch lives
// under one fixed root instead: deletes are best-effort, and the root is
// swept once at suite startup, when the previous process's handles are gone.
// Upgrade path = per-process subdirs if tests ever run concurrently.
const SCRATCH_ROOT = join(tmpdir(), "relic-test");
try {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
} catch {
  // best-effort: a locked leftover is swept on the next run
}

export function tempDir(prefix = "relic-"): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, prefix));
}

/** Copy the fixture into a temp dir so mutation tests never touch sources. */
export function copyFixture(): { root: string; cleanup: () => void } {
  const dir = tempDir();
  const root = join(dir, "starter-hono");
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return {
    root,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Best-effort removal: a few quick pumps for the common case, then leave
 * locked leftovers for the startup sweep. Never blocks a hook past ~0.5s.
 */
export async function cleanup(paths: string[]): Promise<void> {
  for (const path of paths) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(path, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}
