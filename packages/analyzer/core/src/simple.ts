import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic, GraphNode, NodeType } from "@relic/graph-core";
import type { RepositoryContext } from "./discovery";
import { isTestFile, sha1 } from "./discovery";
import {
  databaseTableId,
  fileId,
  queueId,
  repositoryNodeId,
  routeId,
  symbolId,
  testNodeId,
} from "./ids";
import type {
  Declaration,
  ExtractedFile,
  HandlerRef,
  ImportBinding,
  PendingCall,
  PendingMessage,
  PendingSql,
  RefInfo,
} from "./types";

export interface SimpleDeclaration {
  re: RegExp;
  kind: Declaration["kind"];
  /** Containers (e.g. Rust `impl`) scope children but emit no symbol node. */
  container?: boolean;
}

export interface SimpleRoute {
  re: RegExp;
  method: (match: RegExpExecArray) => string;
  path: (match: RegExpExecArray) => string;
  /** Inline routes (Go, Axum) name their handler in the match. */
  handler?: (match: RegExpExecArray) => string | null;
}

export interface SimpleImport {
  re: RegExp;
  resolve(specifier: string, repo: RepositoryContext, filePath: string): string | null;
}

interface SimpleLanguageConfig {
  id: string;
  keywords: Set<string>;
  declarations: SimpleDeclaration[];
  imports: SimpleImport[];
  routes?: SimpleRoute[];
  /** Go-style methods live outside the type block; keep the container for the file. */
  fileScopedContainers?: boolean;
}

interface Scope {
  id: string;
  start: number;
  end: number;
}

const PUBLISH_METHODS = new Set([
  "publish",
  "Publish",
  "send",
  "Send",
  "produce",
  "Produce",
  "emit",
  "Emit",
  "push",
  "Push",
  "enqueue",
  "Enqueue",
]);
const CONSUME_METHODS = new Set([
  "subscribe",
  "Subscribe",
  "consume",
  "Consume",
  "receive",
  "Receive",
  "listen",
  "Listen",
  "dequeue",
  "Dequeue",
]);
const SQL_PATTERN = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i;
const SQL_TABLE_PATTERN = /\b(?:FROM|INTO|UPDATE)\s+[`"]?(\w+)/i;

/** End line of the brace-delimited block that starts on `start` (1-based). */
function braceEnd(lines: string[], start: number): number {
  let depth = 0;
  let seen = false;
  for (let i = start - 1; i < lines.length; i++) {
    for (const char of lines[i] ?? "") {
      if (char === "{") {
        depth++;
        seen = true;
      } else if (char === "}") {
        depth--;
        if (seen && depth <= 0) return i + 1;
      }
    }
  }
  return start;
}

/** Regex-driven extractor shared by the brace-language analyzers. */
export function extractSimpleFile(
  repo: RepositoryContext,
  filePath: string,
  content: string | undefined,
  config: SimpleLanguageConfig,
): ExtractedFile {
  const text = content ?? readFileSync(join(repo.rootPath, filePath), "utf8");
  const contentHash = sha1(text);
  const lines = text.split(/\r?\n/);
  const now = new Date().toISOString();
  const isTest = isTestFile(filePath);
  const nodes: GraphNode[] = [];
  const declarations: Declaration[] = [];
  const refs: RefInfo[] = [];
  const imports: ImportBinding[] = [];
  const calls: PendingCall[] = [];
  const handlers: ExtractedFile["handlers"] = [];
  const sql: PendingSql[] = [];
  const messages: PendingMessage[] = [];
  const diagnostics: Diagnostic[] = [];
  const scopes: Scope[] = [];

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
        metadata: { kind, language: config.id },
      }),
    );
    refs.push({ id, name: simpleName, qualifiedName, filePath });
    const scope: Scope = { id, start: startLine, end: endLine };
    scopes.push(scope);
    return id;
  };

  // Pass 1: imports.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const pattern of config.imports) {
      const match = pattern.re.exec(line);
      if (!match?.[1]) continue;
      const specifier = match[1];
      const target = pattern.resolve(specifier, repo, filePath);
      const localName = match[2] ?? specifier.split(/[./:]/).filter(Boolean).pop() ?? specifier;
      imports.push({ localName, targetFile: target, exportName: localName, specifier });
      break;
    }
  }

  // Pass 2: declarations, route annotations, calls, SQL and queues.
  const containers: Array<{ name: string; end: number }> = [];
  let pendingRoute: { method: string; path: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    while (containers.length > 0 && lineNo > containers[containers.length - 1]!.end) {
      containers.pop();
    }

    for (const route of config.routes ?? []) {
      const match = route.re.exec(line);
      if (!match) continue;
      const method = route.method(match);
      const path = route.path(match);
      const handler = route.handler?.(match) ?? null;
      if (handler) {
        emitRoute(
          makeNode,
          repo.id,
          filePath,
          method,
          path,
          lineNo,
          nodes,
          refs,
          handlers,
          handler,
        );
      } else {
        pendingRoute = { method, path };
      }
      break;
    }

    for (const pattern of config.declarations) {
      const match = pattern.re.exec(line);
      if (!match?.[1]) continue;
      const name = match[1];
      const end = braceEnd(lines, lineNo);
      if (pattern.container) {
        containers.push({ name, end });
        break;
      }
      const container = containers[containers.length - 1]?.name;
      const qualifiedName = container ? `${container}.${name}` : name;
      const isMethod = pattern.kind === "method" || (pattern.kind === "function" && !!container);
      declare(name, qualifiedName, isMethod ? "method" : pattern.kind, lineNo, end);
      if (pattern.kind === "class") {
        if (config.fileScopedContainers) containers.length = 0;
        containers.push({
          name: qualifiedName,
          end: config.fileScopedContainers ? lines.length : end,
        });
      }
      if (pendingRoute) {
        emitRoute(
          makeNode,
          repo.id,
          filePath,
          pendingRoute.method,
          pendingRoute.path,
          lineNo,
          nodes,
          refs,
          handlers,
          name,
          end,
        );
        pendingRoute = null;
      }
      break;
    }

    // Calls: name(...), obj.method(...), self.method(...).
    const callPattern = /\b([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\(/g;
    let call: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((call = callPattern.exec(line))) {
      const objName = call[1]!;
      const propName = call[2];
      if (!propName && config.keywords.has(objName)) continue;
      const key = `${call.index}:${objName}.${propName ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sourceId = scopeAt(scopes, lineNo, filePath, repo.id, isTest);
      const containerName = containers[containers.length - 1]?.name ?? "";
      calls.push(
        propName
          ? objName === "self" || objName === "this"
            ? {
                sourceId,
                line: lineNo,
                kind: "this-property",
                propName,
                classQualifiedName: containerName,
              }
            : { sourceId, line: lineNo, kind: "property", exprName: objName, propName }
          : { sourceId, line: lineNo, kind: "identifier", name: objName },
      );
      if (propName && (PUBLISH_METHODS.has(propName) || CONSUME_METHODS.has(propName))) {
        const queue = /^\s*["']([^"']+)["']/.exec(line.slice(call.index + call[0].length))?.[1];
        if (queue) {
          messages.push({
            sourceId,
            queue,
            mode: PUBLISH_METHODS.has(propName) ? "PUBLISHES" : "CONSUMES",
            line: lineNo,
            excerpt: trimmed.slice(0, 120),
          });
          ensureNode(nodes, makeNode, queueId(repo.id, queue), "queue", queue, { kind: "queue" });
        }
      }
    }

    for (const literal of line.match(/(['"])(.*?)\1/g) ?? []) {
      const value = literal.slice(1, -1);
      if (!SQL_PATTERN.test(value)) continue;
      const table = value.match(SQL_TABLE_PATTERN)?.[1];
      if (!table) continue;
      ensureNode(nodes, makeNode, databaseTableId(repo.id, table), "database_table", table, {
        table,
      });
      sql.push({
        sourceId: scopeAt(scopes, lineNo, filePath, repo.id, isTest),
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

function scopeAt(
  scopes: Scope[],
  line: number,
  filePath: string,
  repositoryId: string,
  isTest: boolean,
): string {
  let best: Scope | null = null;
  for (const scope of scopes) {
    if (line < scope.start || line > scope.end) continue;
    if (!best || scope.end - scope.start < best.end - best.start) best = scope;
  }
  return best?.id ?? (isTest ? testNodeId(repositoryId, filePath) : fileId(repositoryId, filePath));
}

function emitRoute(
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
  filePath: string,
  method: string,
  path: string,
  line: number,
  nodes: GraphNode[],
  refs: RefInfo[],
  handlers: ExtractedFile["handlers"],
  handler: string,
  end = line,
): void {
  const qn = `${method} ${path}`;
  const id = routeId(repositoryId, method, path);
  nodes.push(
    makeNode(id, "route", qn, {
      qualifiedName: qn,
      startLine: line,
      endLine: end,
      metadata: { method, path, framework: "simple" },
    }),
  );
  refs.push({ id, name: qn, qualifiedName: qn, filePath });
  const ref: HandlerRef = { kind: "identifier", name: handler };
  handlers.push({ containerId: id, ref, line });
}

function ensureNode(
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
  id: string,
  type: NodeType,
  name: string,
  metadata: Record<string, unknown>,
): void {
  if (nodes.some((node) => node.id === id)) return;
  nodes.push(makeNode(id, type, name, { qualifiedName: name, nodeFilePath: null, metadata }));
}

export type { SimpleLanguageConfig };
