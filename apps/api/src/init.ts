import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_FALLBACK = `---
name: relic
description: Query the Relic dependency graph before changing code. Use when asked what depends on a symbol, what breaks if X changes, which tests cover X, or how two files/routes/tables connect. Requires the "relic" MCP server.
---

# Relic graph

Facts over guesses. Prefer graph answers to grep/read; never invent relationships.

1. \`get_graph_summary\` confirms the repo is indexed and lists \`diagnostics\`.
   - \`REPOSITORY_NOT_FOUND\` -> call \`index_repository\` first.
   - After a pull or branch switch -> \`index_repository\` (incremental).
2. \`search_symbols(query)\` to resolve names, then reuse the returned \`id\`.
3. "what breaks if I change X" -> \`analyze_impact\`; "which tests" -> \`find_related_tests\`.
4. Cite \`evidence.file:line\`; label confidence < 1.0 as inferred.
5. \`diagnostics\` / unresolved relationships mean unknown coverage, not "safe".
`;

export interface InitResult {
  root: string;
  mcpConfig: string;
  skill: string;
  changed: boolean;
}

/** Write `.mcp.json` and `skills/relic/SKILL.md`; repeated runs are no-ops. */
export function initProject(rootPath: string, options: { force?: boolean } = {}): InitResult {
  const root = resolve(rootPath);
  const mcpPath = join(root, ".mcp.json");
  const existing = readJson(mcpPath);
  const servers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  const nextConfig = {
    ...existing,
    mcpServers: {
      ...servers,
      relic: {
        command: "npx",
        args: ["-y", "relic-graph"],
        env: { RELIC_REPOSITORY: root },
      },
    },
  };
  const mcpText = `${JSON.stringify(nextConfig, null, 2)}\n`;
  const mcpBefore = existsSync(mcpPath) ? readFileSync(mcpPath, "utf8") : null;
  if (mcpBefore !== mcpText) writeFile(mcpPath, mcpText);

  const skillPath = join(root, "skills", "relic", "SKILL.md");
  const skillText = readSkillSource();
  const skillBefore = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : null;
  if (skillBefore === null || options.force === true) {
    if (skillBefore !== skillText) writeFile(skillPath, skillText);
  }

  return {
    root,
    mcpConfig: mcpPath,
    skill: skillPath,
    changed: mcpBefore !== mcpText || (skillBefore === null && skillText.length > 0),
  };
}

function readSkillSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "skills", "relic", "SKILL.md"), // published: dist/skills
    join(here, "..", "..", "..", "skills", "relic", "SKILL.md"), // dev: repo/skills
  ]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return SKILL_FALLBACK;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    throw new Error(`Cannot parse ${path}; fix or remove it before running init`);
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
