import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractSimpleFile, type RepositoryContext } from "@relic/analyzer-core";

const JAVA_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "new",
  "throw",
  "assert",
  "synchronized",
  "try",
  "else",
  "super",
  "this",
]);

function resolveJavaImport(
  specifier: string,
  repo: RepositoryContext,
  _filePath: string,
): string | null {
  const base = specifier.replace(/\./g, "/");
  for (const candidate of [
    `${base}.java`,
    `src/main/java/${base}.java`,
    `src/test/java/${base}.java`,
  ]) {
    if (existsSync(join(repo.rootPath, candidate))) return candidate;
  }
  return null;
}

const config = {
  id: "java",
  keywords: JAVA_KEYWORDS,
  imports: [{ re: /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/, resolve: resolveJavaImport }],
  declarations: [
    {
      re: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/,
      kind: "class" as const,
    },
    {
      re: /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/,
      kind: "method" as const,
    },
    {
      re: /^\s*(?:public|private|protected)\s+([A-Z]\w*)\s*\(/,
      kind: "method" as const,
    },
  ],
  routes: [
    {
      re: /@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/,
      method: (match: RegExpExecArray): string => match[1]!.toUpperCase(),
      path: (match: RegExpExecArray): string => match[2]!,
    },
    {
      re: /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/,
      method: (): string => "ANY",
      path: (match: RegExpExecArray): string => match[1]!,
    },
  ],
};

export function extractJavaFile(repo: RepositoryContext, filePath: string, content?: string) {
  return extractSimpleFile(repo, filePath, content, config);
}
