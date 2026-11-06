import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Diagnostic, GraphNode, NodeType } from "@relic/graph-core";
import type { RepositoryContext } from "@relic/analyzer-core";
import { isTestFile, sha1 } from "@relic/analyzer-core";
import {
  databaseTableId,
  fileId,
  queueId,
  repositoryNodeId,
  routeId,
  symbolId,
  testNodeId,
} from "@relic/analyzer-core";
import type {
  Declaration,
  ExtractedFile,
  HandlerRef,
  ImportBinding,
  PendingCall,
  PendingMessage,
  PendingSql,
  RefInfo,
} from "@relic/analyzer-core";

const PY_KEYWORDS = new Set([
  "if",
  "elif",
  "else",
  "for",
  "while",
  "with",
  "try",
  "except",
  "finally",
  "def",
  "class",
  "return",
  "yield",
  "lambda",
  "match",
  "case",
  "assert",
  "raise",
  "import",
  "from",
  "as",
  "pass",
  "del",
  "global",
  "nonlocal",
]);
const PUBLISH_METHODS = new Set(["publish", "send", "produce", "emit", "push", "enqueue"]);
const CONSUME_METHODS = new Set(["subscribe", "consume", "receive", "listen", "dequeue"]);
const SQL_PATTERN = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i;
const SQL_TABLE_PATTERN = /\b(?:FROM|INTO|UPDATE)\s+[`"]?(\w+)/i;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isCommentOrBlank(line: string): boolean {
  const trim = line.trim();
  return trim.length === 0 || trim.startsWith("#");
}

/** End line for a Python block by indentation (1-based, inclusive). */
function blockEnd(lines: string[], start: number, indent: number): number {
  let end = start;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentOrBlank(line)) continue;
    if (indentOf(line) <= indent) break;
    end = i + 1;
  }
  return end;
}

function pythonModulePath(module: string): string {
  return module.replace(/\./g, "/");
}

function probePython(repo: RepositoryContext, base: string): string | null {
  const clean = normalize(base).split("\\").join("/");
  if (clean.startsWith("..") || clean.split("/").includes("..")) return null;
  for (const candidate of [`${clean}.py`, `${clean}/__init__.py`]) {
    if (existsSync(join(repo.rootPath, candidate))) return candidate;
  }
  return null;
}

function resolvePythonModule(
  repo: RepositoryContext,
  fromFile: string,
  module: string,
  level: number,
): string | null {
  const parts = module ? pythonModulePath(module) : "";
  if (level > 0) {
    let base = dirname(fromFile);
    for (let i = 1; i < level; i++) base = dirname(base);
    return probePython(repo, parts ? join(base, parts) : base);
  }
  return (
    probePython(repo, parts) ??
    probePython(repo, join("src", parts)) ??
    (parts ? null : probePython(repo, "."))
  );
}

interface PyScope {
  id: string;
  start: number;
  end: number;
}

interface PyDeclaration extends Declaration {
  startLine: number;
  endLine: number;
}

export function extractPythonFile(
  repo: RepositoryContext,
  filePath: string,
  content?: string,
): ExtractedFile {
  const text = content ?? readFileSync(join(repo.rootPath, filePath), "utf8");
  const contentHash = sha1(text);
  const lines = text.split(/\r?\n/);
  const now = new Date().toISOString();
  const nodes: GraphNode[] = [];
  const declarations: PyDeclaration[] = [];
  const refs: RefInfo[] = [];
  const imports: ImportBinding[] = [];
  const calls: PendingCall[] = [];
  const messages: PendingMessage[] = [];
  const handlers: ExtractedFile["handlers"] = [];
  const sql: PendingSql[] = [];
  const diagnostics: Diagnostic[] = [];
  const isTest = isTestFile(filePath);
  const scopes: PyScope[] = [];

  const makeNode = (
    id: string,
    type: NodeType,
    name: string,
    opts: {
      qualifiedName?: string;
      startLine?: number;
      endLine?: number;
      nodeFilePath?: string | null;
      metadata?: Record<string, unknown>;
      hash?: string;
    } = {},
  ): GraphNode => ({
    id,
    repositoryId: repo.id,
    type,
    name,
    qualifiedName: opts.qualifiedName ?? null,
    filePath: opts.nodeFilePath === undefined ? filePath : opts.nodeFilePath,
    startLine: opts.startLine ?? null,
    endLine: opts.endLine ?? null,
    metadata: opts.metadata ?? {},
    contentHash: opts.hash ?? null,
    updatedAt: now,
  });

  nodes.push(makeNode(repositoryNodeId(repo.id), "repository", repo.name, { nodeFilePath: null }));
  nodes.push(makeNode(fileId(repo.id, filePath), "file", filePath, { hash: contentHash }));
  if (isTest) nodes.push(makeNode(testNodeId(repo.id, filePath), "test", filePath));

  const declare = (
    simpleName: string,
    qualifiedName: string,
    kind: Declaration["kind"],
    startLine: number,
    endLine: number,
  ): string => {
    const id = symbolId(repo.id, filePath, qualifiedName);
    declarations.push({ id, simpleName, qualifiedName, kind, startLine, endLine });
    nodes.push(
      makeNode(id, "symbol", simpleName, {
        qualifiedName,
        startLine,
        endLine,
        metadata: { kind, language: "python" },
      }),
    );
    refs.push({ id, name: simpleName, qualifiedName, filePath });
    return id;
  };

  // Pass 1: classes, functions/methods, module variables.
  const classStack: Array<{ indent: number; name: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentOrBlank(line)) continue;
    const indent = indentOf(line);
    while (classStack.length > 0 && indent <= classStack[classStack.length - 1]!.indent) {
      classStack.pop();
    }

    const classMatch = /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/.exec(line);
    if (classMatch?.[1]) {
      const name = classMatch[1];
      const end = blockEnd(lines, i + 1, indent);
      const id = declare(name, name, "class", i + 1, end);
      scopes.push({ id, start: i + 1, end });
      classStack.push({ indent, name });
      continue;
    }

    const defMatch = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (defMatch?.[1]) {
      const name = defMatch[1];
      const owner = classStack[classStack.length - 1]?.name;
      const qualified = owner ? `${owner}.${name}` : name;
      const end = blockEnd(lines, i + 1, indent);
      const id = declare(name, qualified, owner ? "method" : "function", i + 1, end);
      scopes.push({ id, start: i + 1, end });
      continue;
    }

    const variable = /^([A-Za-z_]\w*)\s*=\s*/.exec(line);
    if (
      indent === 0 &&
      variable?.[1] &&
      !/^(if|for|while|with|try|except|return|import|from)\b/.test(line)
    ) {
      declare(variable[1], variable[1], "variable", i + 1, i + 1);
    }
  }

  const scopeAt = (line: number): string => {
    let best: PyScope | null = null;
    for (const scope of scopes) {
      if (line < scope.start || line > scope.end) continue;
      if (!best || scope.end - scope.start < best.end - best.start) best = scope;
    }
    return best?.id ?? (isTest ? testNodeId(repo.id, filePath) : fileId(repo.id, filePath));
  };

  classStack.length = 0;

  // Pass 2: imports, routes, calls, SQL and queue operations.
  const routeContainers: PyScope[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentOrBlank(line)) continue;
    const lineNo = i + 1;

    const fromMatch = /^\s*from\s+([.\w]*)\s+import\s+(.+)$/.exec(line);
    const importMatch = /^\s*import\s+(.+)$/.exec(line);
    if (fromMatch) {
      const rawModule = fromMatch[1] ?? "";
      const level = rawModule.match(/^\.+/)?.[0].length ?? 0;
      const module = rawModule.replace(/^\.+/, "");
      const target = resolvePythonModule(repo, filePath, module, level);
      if ((level > 0 || module) && !target) {
        diagnostics.push({
          kind: "unresolved",
          message: `Cannot resolve Python import "${rawModule}"`,
          file: filePath,
          line: lineNo,
        });
      }
      for (const item of (fromMatch[2] ?? "").split(",")) {
        const parts = item.trim().split(/\s+as\s+/);
        const name = parts[0]?.trim();
        if (!name || name === "*") continue;
        const localName = parts[1]?.trim() ?? name;
        const submodule = target ? target.replace(/\/__init__\.py$/, "") : null;
        const sub = submodule ? probePython(repo, join(submodule, name)) : null;
        imports.push({
          localName,
          targetFile: sub ?? target,
          exportName: name,
          specifier: rawModule,
        });
      }
      continue;
    }
    if (importMatch) {
      for (const item of (importMatch[1] ?? "").split(",")) {
        const parts = item.trim().split(/\s+as\s+/);
        const module = parts[0]?.trim();
        if (!module) continue;
        const target = resolvePythonModule(repo, filePath, module, 0);
        const localName = parts[1]?.trim() ?? module.split(".")[0]!;
        if (parts[1] && !target) {
          diagnostics.push({
            kind: "unresolved",
            message: `Cannot resolve Python import "${module}"`,
            file: filePath,
            line: lineNo,
          });
        }
        imports.push({ localName, targetFile: target, exportName: localName, specifier: module });
      }
      continue;
    }

    const decorator =
      /^\s*@([A-Za-z_]\w*)\.(route|get|post|put|patch|delete|head|options|websocket)\s*\((.+)\)\s*$/.exec(
        line,
      );
    if (decorator) {
      const obj = decorator[1]!;
      const method = decorator[2]!;
      const args = decorator[3] ?? "";
      if (method === "websocket") {
        const path = /["']([^"']+)["']/.exec(args)?.[1];
        if (path) {
          const qn = `ws:${path}`;
          const id = routeId(repo.id, "WS", path);
          nodes.push(
            makeNode(id, "api_operation", qn, {
              qualifiedName: qn,
              startLine: lineNo,
              endLine: lineNo,
              metadata: { kind: "websocket", event: path, framework: "python" },
            }),
          );
          refs.push({ id, name: qn, qualifiedName: qn, filePath });
          routeContainers.push({ id, start: lineNo, end: lineNo });
        }
        continue;
      }
      const path = /["']([^"']+)["']/.exec(args)?.[1];
      if (!path) continue;
      const methods =
        method === "route"
          ? (/\bmethods\s*=\s*\[([^\]]+)\]/.exec(args)?.[1] ?? "GET")
              .split(",")
              .map((m) => m.trim().replace(/["']/g, "").toUpperCase())
              .filter(Boolean)
          : [method.toUpperCase()];
      const handlerLine = nextDefLine(lines, i + 1);
      const handlerName = handlerLine
        ? /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(lines[handlerLine - 1] ?? "")?.[1]
        : null;
      const end = handlerLine
        ? blockEnd(lines, handlerLine, indentOf(lines[handlerLine - 1]!))
        : lineNo;
      for (const httpMethod of methods) {
        const qn = `${httpMethod} ${path}`;
        const id = routeId(repo.id, httpMethod, path);
        nodes.push(
          makeNode(id, "route", qn, {
            qualifiedName: qn,
            startLine: lineNo,
            endLine: end,
            metadata: { method: httpMethod, path, framework: "python", router: obj },
          }),
        );
        refs.push({ id, name: qn, qualifiedName: qn, filePath });
        routeContainers.push({ id, start: lineNo, end });
        if (handlerName)
          handlers.push({ containerId: id, ref: handlerRef(handlerName), line: lineNo });
      }
      continue;
    }

    const django = /^\s*(?:re_)?path\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_]\w*)/.exec(line);
    if (django) {
      const path = django[1]!.replace(/<[^>]+>/g, ":id").replace(/\/$/, "") || "/";
      const handlerName = django[2]!;
      const qn = `ANY ${path}`;
      const id = routeId(repo.id, "ANY", path);
      nodes.push(
        makeNode(id, "route", qn, {
          qualifiedName: qn,
          startLine: lineNo,
          endLine: lineNo,
          metadata: { method: "ANY", path, framework: "django" },
        }),
      );
      refs.push({ id, name: qn, qualifiedName: qn, filePath });
      handlers.push({ containerId: id, ref: handlerRef(handlerName), line: lineNo });
      continue;
    }

    // Local instance aliases: `service = UserService()` and
    // `self.repo = UserRepository()`. Property calls through the alias then
    // resolve against the class's module.
    const assignment = /^\s*(?:self\.)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/.exec(line);
    if (assignment?.[1] && assignment[2]) {
      const classBinding = imports.find((i) => i.localName === assignment[2]);
      if (classBinding?.targetFile && !imports.some((i) => i.localName === assignment[1])) {
        imports.push({
          localName: assignment[1],
          targetFile: classBinding.targetFile,
          exportName: classBinding.exportName,
          ...(classBinding.specifier ? { specifier: classBinding.specifier } : {}),
        });
      }
    }

    // Calls: `name(...)`, `obj.method(...)`, `self.method(...)`.
    const callPattern = /\b([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\(/g;
    let match: RegExpExecArray | null;
    const seenCalls = new Set<string>();
    while ((match = callPattern.exec(line))) {
      const objName = match[1]!;
      const propName = match[2];
      if (!propName && PY_KEYWORDS.has(objName)) continue;
      const key = `${match.index}:${objName}.${propName ?? ""}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      const container = routeContainers.find((c) => lineNo >= c.start && lineNo <= c.end);
      const sourceId = container?.id ?? scopeAt(lineNo);
      const call: PendingCall = propName
        ? objName === "self"
          ? {
              sourceId,
              line: lineNo,
              kind: "this-property",
              propName,
              classQualifiedName: classStack[classStack.length - 1]?.name ?? "",
            }
          : { sourceId, line: lineNo, kind: "property", exprName: objName, propName }
        : { sourceId, line: lineNo, kind: "identifier", name: objName };
      calls.push(call);

      if (propName && (PUBLISH_METHODS.has(propName) || CONSUME_METHODS.has(propName))) {
        const queue = firstString(line.slice(match.index + match[0].length));
        if (queue) {
          messages.push({
            sourceId,
            queue,
            mode: PUBLISH_METHODS.has(propName) ? "PUBLISHES" : "CONSUMES",
            line: lineNo,
            excerpt: line.trim().slice(0, 120),
          });
          ensureQueueNode(nodes, makeNode, repo.id, queue);
        }
      }
    }

    for (const literal of line.match(/(['"])(.*?)\1/g) ?? []) {
      const value = literal.slice(1, -1);
      if (!SQL_PATTERN.test(value)) continue;
      const table = value.match(SQL_TABLE_PATTERN)?.[1];
      if (!table) continue;
      ensureTableNode(nodes, makeNode, repo.id, table);
      sql.push({
        sourceId: scopeAt(lineNo),
        table,
        mode: /^\s*SELECT/i.test(value) ? "READS" : "WRITES",
        line: lineNo,
        excerpt: value.slice(0, 120),
      });
    }
  }

  return {
    filePath,
    contentHash,
    nodes,
    declarations,
    refs,
    imports,
    calls,
    handlers,
    sql,
    frontend: [],
    messages,
    isTest,
    diagnostics,
  };
}

function nextDefLine(lines: string[], start: number): number | null {
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentOrBlank(line)) continue;
    if (/^\s*(?:async\s+)?def\s+[A-Za-z_]\w*/.test(line)) return i + 1;
    if (!line.trim().startsWith("@")) return null;
  }
  return null;
}

function handlerRef(name: string): HandlerRef {
  return { kind: "identifier", name };
}

function firstString(text: string): string | null {
  return /^\s*["']([^"']+)["']/.exec(text)?.[1] ?? null;
}

function ensureQueueNode(
  nodes: GraphNode[],
  makeNode: (
    id: string,
    type: NodeType,
    name: string,
    opts?: {
      qualifiedName?: string;
      startLine?: number;
      endLine?: number;
      nodeFilePath?: string | null;
      metadata?: Record<string, unknown>;
      hash?: string;
    },
  ) => GraphNode,
  repositoryId: string,
  queue: string,
): void {
  const id = queueId(repositoryId, queue);
  if (nodes.some((node) => node.id === id)) return;
  nodes.push(
    makeNode(id, "queue", queue, {
      qualifiedName: queue,
      nodeFilePath: null,
      metadata: { kind: "queue" },
    }),
  );
}

function ensureTableNode(
  nodes: GraphNode[],
  makeNode: (
    id: string,
    type: NodeType,
    name: string,
    opts?: {
      qualifiedName?: string;
      startLine?: number;
      endLine?: number;
      nodeFilePath?: string | null;
      metadata?: Record<string, unknown>;
      hash?: string;
    },
  ) => GraphNode,
  repositoryId: string,
  table: string,
): void {
  const id = databaseTableId(repositoryId, table);
  if (nodes.some((node) => node.id === id)) return;
  nodes.push(
    makeNode(id, "database_table", table, {
      qualifiedName: table,
      nodeFilePath: null,
      metadata: { table },
    }),
  );
}
