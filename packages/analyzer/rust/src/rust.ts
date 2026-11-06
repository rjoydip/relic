import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractSimpleFile, type RepositoryContext } from "@relic/analyzer-core";

const RUST_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "match",
  "loop",
  "return",
  "let",
  "fn",
  "struct",
  "enum",
  "impl",
  "trait",
  "where",
  "new",
  "panic",
  "assert",
  "vec",
  "Some",
  "Ok",
  "Err",
]);

function resolveRustModule(
  specifier: string,
  repo: RepositoryContext,
  _filePath: string,
): string | null {
  const cleaned = specifier
    .replace(/^(?:crate|super|self)::?/, "")
    .split("::")
    .filter((part) => part && !/^[A-Z]/.test(part))
    .join("/");
  if (!cleaned) return null;
  for (const candidate of [
    `src/${cleaned}.rs`,
    `src/${cleaned}/mod.rs`,
    `${cleaned}.rs`,
    `${cleaned}/mod.rs`,
  ]) {
    if (existsSync(join(repo.rootPath, candidate))) return candidate;
  }
  return null;
}

const config = {
  id: "rust",
  keywords: RUST_KEYWORDS,
  imports: [
    {
      re: /^\s*use\s+((?:crate|super|self)::[\w:]+)/,
      resolve: resolveRustModule,
    },
    {
      re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/,
      resolve: (specifier: string, repo: RepositoryContext, filePath: string) =>
        resolveRustModule(specifier, repo, filePath),
    },
  ],
  declarations: [
    {
      re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+::)?([A-Za-z_]\w*)/,
      kind: "class" as const,
      container: true,
    },
    {
      re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
      kind: "class" as const,
    },
    {
      re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
      kind: "function" as const,
    },
  ],
  routes: [
    {
      re: /#\[(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*\)\s*\]/,
      method: (match: RegExpExecArray): string => match[1]!.toUpperCase(),
      path: (match: RegExpExecArray): string => match[2]!,
    },
    {
      re: /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\(([A-Za-z_]\w*)\)/,
      method: (match: RegExpExecArray): string => match[2]!.toUpperCase(),
      path: (match: RegExpExecArray): string => match[1]!,
      handler: (match: RegExpExecArray): string => match[3]!,
    },
  ],
};

export function extractRustFile(repo: RepositoryContext, filePath: string, content?: string) {
  return extractSimpleFile(repo, filePath, content, config);
}
