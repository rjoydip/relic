import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractSimpleFile, type RepositoryContext } from "@relic/analyzer-core";

const GO_KEYWORDS = new Set([
  "if",
  "for",
  "switch",
  "select",
  "return",
  "go",
  "defer",
  "func",
  "type",
  "range",
  "new",
  "make",
  "panic",
]);

function firstGoFile(dir: string): string | null {
  try {
    const file = readdirSync(dir)
      .filter((name) => name.endsWith(".go"))
      .sort()[0];
    return file ?? null;
  } catch {
    return null;
  }
}

function resolveGoImport(
  specifier: string,
  repo: RepositoryContext,
  _filePath: string,
): string | null {
  const suffix = specifier.split("/").filter(Boolean).pop();
  if (!suffix) return null;
  for (const dir of [specifier, `vendor/${specifier}`, suffix]) {
    const candidate = join(repo.rootPath, dir);
    if (!existsSync(candidate)) continue;
    const file = firstGoFile(candidate);
    if (file) return `${dir}/${file}`.replace(/^\.\//, "");
  }
  return null;
}

const config = {
  id: "go",
  keywords: GO_KEYWORDS,
  fileScopedContainers: true,
  imports: [
    {
      re: /^\s*import\s+(?:[A-Za-z_.]\w*\s+)?"([^"]+)"/,
      resolve: resolveGoImport,
    },
    {
      re: /^\s*"([^"]+)"\s*$/,
      resolve: resolveGoImport,
    },
  ],
  declarations: [
    {
      re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\s*\{/,
      kind: "class" as const,
    },
    {
      re: /^\s*func\s+\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/,
      kind: "method" as const,
    },
    {
      re: /^\s*func\s+([A-Za-z_]\w*)\s*\(/,
      kind: "function" as const,
    },
  ],
  routes: [
    {
      re: /\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z_]\w*)/,
      method: (match: RegExpExecArray): string => match[1]!,
      path: (match: RegExpExecArray): string => match[2]!,
      handler: (match: RegExpExecArray): string => match[3]!,
    },
    {
      re: /HandleFunc\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z_]\w*)/,
      method: (): string => "ANY",
      path: (match: RegExpExecArray): string => match[1]!,
      handler: (match: RegExpExecArray): string => match[2]!,
    },
  ],
};

export function extractGoFile(repo: RepositoryContext, filePath: string, content?: string) {
  return extractSimpleFile(repo, filePath, content, config);
}
