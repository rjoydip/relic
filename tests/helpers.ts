import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

export function tempDir(prefix = "mcpdg-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeTempFile(name: string, content: string): string {
  const dir = tempDir();
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
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

export async function cleanup(paths: string[]): Promise<void> {
  for (const path of paths) {
    // ponytail: bun's node:sqlite releases file handles on a later event-loop
    // turn (wall-clock waiting never works), and Windows blocks rm until then.
    // Retry while pumping the loop; upgrade path = per-test fixed DB location
    // + sweep on startup if a slow CI machine outlives the 5s ceiling.
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        rmSync(path, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt === 49) throw err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}
