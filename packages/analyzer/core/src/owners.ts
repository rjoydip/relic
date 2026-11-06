import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CodeownerRule {
  pattern: string;
  owners: string[];
  negated: boolean;
}

const CODEOWNERS_LOCATIONS = [".github/CODEOWNERS", "docs/CODEOWNERS", "CODEOWNERS"];

/** Parse the first CODEOWNERS file found at the repository root. */
export function loadCodeowners(rootPath: string): CodeownerRule[] {
  for (const relative of CODEOWNERS_LOCATIONS) {
    const absolute = join(rootPath, relative);
    if (!existsSync(absolute)) continue;
    try {
      return parseCodeowners(readFileSync(absolute, "utf8"));
    } catch {
      return [];
    }
  }
  return [];
}

export function parseCodeowners(text: string): CodeownerRule[] {
  const rules: CodeownerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, owners, negated: pattern.startsWith("!") });
  }
  return rules;
}

/**
 * Gitignore-style matching, last matching rule wins (GitHub semantics).
 * Supports `*`, `**`, `?`, root anchors, and directory patterns.
 */
export function ownersFor(rules: CodeownerRule[], filePath: string): string[] {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.?\//, "");
  let result: string[] = [];
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, normalized)) continue;
    result = rule.negated ? [] : rule.owners;
  }
  return result;
}

function patternMatches(pattern: string, filePath: string): boolean {
  const body = pattern.replace(/^!/, "");
  const anchored = body.startsWith("/") || (body.includes("/") && !body.endsWith("/"));
  const dirOnly = body.endsWith("/");
  const trimmed = body.replace(/^\/+/, "").replace(/\/+$/, "");
  let source = "";
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!;
    if (char === "*") {
      if (trimmed[i + 1] === "*") {
        source += ".*";
        i++;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if ("\\^$+.|()[]{}".includes(char)) source += `\\${char}`;
    else source += char;
  }
  const prefix = anchored ? "^" : "(?:^|.*/)";
  const suffix = dirOnly ? "(?:/.*)?$" : "$";
  return new RegExp(prefix + source + suffix).test(filePath);
}

export interface BlameAuthor {
  name: string;
  email: string;
  commit: string;
  lines: number;
}

export interface BlameResult {
  lineCount: number;
  authors: BlameAuthor[];
}

/** `git blame` over the node's line range, summarised by author. */
export function blameRange(
  rootPath: string,
  filePath: string,
  startLine: number | null | undefined,
  endLine: number | null | undefined,
): BlameResult | null {
  const from = Math.max(1, startLine ?? 1);
  const to = Math.max(from, endLine ?? from);
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["blame", "--line-porcelain", "-L", `${from},${to}`, "--", filePath],
      {
        cwd: rootPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch {
    return null;
  }
  return parseBlamePorcelain(output);
}

/** Split `git blame --line-porcelain` output into author line counts. */
export function parseBlamePorcelain(output: string): BlameResult {
  const authors = new Map<string, BlameAuthor>();
  let name = "";
  let email = "";
  let commit = "";
  let lineCount = 0;
  for (const line of output.split("\n")) {
    const header = /^([0-9a-f]{7,40}) \d+ \d+/.exec(line);
    if (header) {
      commit = header[1]!;
      continue;
    }
    if (line.startsWith("author ")) {
      name = line.slice(7);
      continue;
    }
    if (line.startsWith("author-mail ")) {
      email = line.slice(12).replace(/[<>]/g, "");
      continue;
    }
    if (!line.startsWith("\t")) continue;
    lineCount++;
    const key = email || name;
    const entry = authors.get(key);
    if (entry) entry.lines++;
    else authors.set(key, { name: name || "(unknown)", email, commit, lines: 1 });
  }
  return {
    lineCount,
    authors: [...authors.values()].sort((a, b) => b.lines - a.lines),
  };
}
