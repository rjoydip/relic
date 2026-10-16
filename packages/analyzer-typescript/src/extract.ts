import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Diagnostic, GraphNode, NodeType } from "@mcpdg/graph-core";
import type { RepositoryContext } from "./discovery";
import { IGNORED_DIRS, SUPPORTED_EXTENSIONS, extOf, isTestFile, sha1 } from "./discovery";
import {
  apiOperationId,
  databaseTableId,
  frontendOperationId,
  repositoryNodeId,
  routeId,
  symbolId,
  testNodeId,
  fileId,
} from "./ids";
import * as ts from "typescript";

export const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export interface Declaration {
  id: string;
  simpleName: string;
  qualifiedName: string;
  kind: "function" | "class" | "method" | "variable";
  startLine: number;
  endLine: number;
}

export interface ImportBinding {
  localName: string;
  /** null = external (npm) module. */
  targetFile: string | null;
  exportName: string;
}

export interface PendingCall {
  sourceId: string;
  line: number;
  kind: "identifier" | "property" | "this-property";
  name?: string;
  exprName?: string;
  propName?: string;
  classQualifiedName?: string;
}

export interface HandlerRef {
  kind: "identifier" | "property" | "inline";
  name?: string;
  exprName?: string;
  propName?: string;
}

export interface PendingHandler {
  containerId: string;
  ref: HandlerRef;
  line: number;
}

export interface PendingSql {
  sourceId: string;
  table: string;
  mode: "READS" | "WRITES";
  line: number;
  excerpt: string;
}

export interface PendingFrontend {
  nodeId: string;
  method: string;
  path: string;
  line: number;
}

/** Everything cross-file resolution can target, for the shared ref lookup. */
export interface RefInfo {
  id: string;
  name: string;
  qualifiedName: string;
  filePath: string;
}

export interface ExtractedFile {
  filePath: string;
  contentHash: string;
  nodes: GraphNode[];
  declarations: Declaration[];
  refs: RefInfo[];
  imports: ImportBinding[];
  calls: PendingCall[];
  handlers: PendingHandler[];
  sql: PendingSql[];
  frontend: PendingFrontend[];
  isTest: boolean;
  diagnostics: Diagnostic[];
}

export interface RefLookup {
  findByName(name: string): RefInfo[];
}

const SQL_PATTERN = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i;
const SQL_TABLE_PATTERN = /\b(?:FROM|INTO|UPDATE)\s+[`"]?(\w+)/i;
const MUTATION_KEYS = new Set(["Mutation", "Query", "Subscription"]);

export function extractFile(
  repo: RepositoryContext,
  filePath: string,
  content?: string,
): ExtractedFile {
  const abs = join(repo.rootPath, filePath);
  const text = content ?? readFileSync(abs, "utf8");
  const contentHash = sha1(text);
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  const now = new Date().toISOString();

  const nodes: GraphNode[] = [];
  const declarations: Declaration[] = [];
  const refs: RefInfo[] = [];
  const imports: ImportBinding[] = [];
  const diagnostics: Diagnostic[] = [];
  const isTest = isTestFile(filePath);
  const declarationIds = new Map<ts.Node, string>();
  const containers: Array<{ id: string; start: number; end: number }> = [];
  const rawCalls: Array<{ node: ts.Node; info: Omit<PendingCall, "sourceId"> }> = [];
  const rawSql: Array<{ node: ts.Node; info: Omit<PendingSql, "sourceId"> }> = [];
  const handlers: PendingHandler[] = [];
  const frontend: PendingFrontend[] = [];
  let currentClass: string | null = null;

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

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
    node: ts.Node,
    simpleName: string,
    qualifiedName: string,
    kind: Declaration["kind"],
  ): void => {
    const decl: Declaration = {
      id: symbolId(repo.id, filePath, qualifiedName),
      simpleName,
      qualifiedName,
      kind,
      startLine: lineOf(node.getStart()),
      endLine: lineOf(node.getEnd()),
    };
    declarations.push(decl);
    nodes.push(
      makeNode(decl.id, "symbol", simpleName, {
        qualifiedName,
        startLine: decl.startLine,
        endLine: decl.endLine,
        metadata: { kind },
      }),
    );
    refs.push({ id: decl.id, name: simpleName, qualifiedName, filePath });
    declarationIds.set(node, decl.id);
  };

  const containerFor = (pos: number): string | null => {
    // Containers (route / ws / GraphQL operation scopes) are more specific
    // than the enclosing declaration, so they win when a call sits inside one.
    for (let i = containers.length - 1; i >= 0; i--) {
      const c = containers[i]!;
      if (pos >= c.start && pos <= c.end) return c.id;
    }
    return null;
  };

  const findSourceId = (start: number): string | null => {
    const container = containerFor(start);
    if (container) return container;
    let probe: ts.Node | undefined = firstNodeAt(start);
    while (probe) {
      const id = declarationIds.get(probe);
      if (id) return id;
      probe = probe.parent;
    }
    return isTest ? testNodeId(repo.id, filePath) : null;
  };

  const firstNodeAt = (start: number): ts.Node | undefined => {
    let found: ts.Node | undefined;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (n.getStart() <= start && n.getEnd() >= start) {
        if (n.getStart() === start) {
          found = n;
          return;
        }
        n.forEachChild(visit);
      }
    };
    visit(sf);
    return found;
  };

  const handlerRefOf = (arg: ts.Expression | undefined): HandlerRef => {
    if (!arg) return { kind: "inline" };
    if (ts.isIdentifier(arg)) return { kind: "identifier", name: arg.text };
    if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression)) {
      return { kind: "property", exprName: arg.expression.text, propName: arg.name.text };
    }
    return { kind: "inline" };
  };

  const stringArg = (arg: ts.Expression | undefined): string | null => {
    if (!arg) return null;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const resolved = resolveImport(repo, filePath, specifier);
      if (resolved.kind !== "ok" && resolved.kind !== "external") {
        diagnostics.push({
          kind: "unresolved",
          message: `Cannot resolve import "${specifier}" (${resolved.kind})`,
          file: filePath,
          line: lineOf(node.getStart()),
        });
      }
      const targetFile = resolved.kind === "ok" ? resolved.path : null;
      const clause = node.importClause;
      if (clause?.name)
        imports.push({ localName: clause.name.text, targetFile, exportName: clause.name.text });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (el.isTypeOnly) continue;
          imports.push({
            localName: (el.propertyName ?? el.name).text,
            targetFile,
            exportName: el.name.text,
          });
        }
      }
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const prevClass = currentClass;
      currentClass = node.name.text;
      declare(node, node.name.text, node.name.text, "class");
      node.forEachChild(visit);
      currentClass = prevClass;
      return;
    }

    if (ts.isMethodDeclaration(node) && node.name && currentClass) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
          ? node.name.text
          : node.name.getText(sf);
      declare(node, name, `${currentClass}.${name}`, "method");
      node.forEachChild(visit);
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      declare(node, node.name.text, node.name.text, "function");
      node.forEachChild(visit);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      const name = node.name.text;
      // Instance exports (`export const userService = new UserService()`) are
      // resolution targets for imports, so every named variable is declared.
      declare(node, name, name, "variable");

      if (/^(?:.+\.)?(?:\w+)(?:Mutation|Query)$/.test(name)) {
        const id = frontendOperationId(repo.id, name);
        const line = lineOf(node.getStart());
        nodes.push(
          makeNode(id, "frontend_operation", name, {
            qualifiedName: name,
            startLine: line,
            endLine: lineOf(node.getEnd()),
          }),
        );
        refs.push({ id, name, qualifiedName: name, filePath });
        const mapping = init ? extractEndpointMapping(init) : null;
        if (mapping)
          frontend.push({ nodeId: id, method: mapping.method, path: mapping.path, line });
      }

      node.forEachChild(visit);
      return;
    }

    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText().replace(/^["']|["']$/g, "");
      if (MUTATION_KEYS.has(key) && ts.isObjectLiteralExpression(node.initializer)) {
        for (const child of node.initializer.properties) {
          if (!ts.isPropertyAssignment(child)) continue;
          const childName = child.name.getText().replace(/^["']|["']$/g, "");
          const qn = `${key}.${childName}`;
          const id = apiOperationId(repo.id, qn);
          const line = lineOf(child.getStart());
          nodes.push(
            makeNode(id, "api_operation", qn, {
              qualifiedName: qn,
              startLine: line,
              endLine: lineOf(child.getEnd()),
              metadata: { kind: "graphql" },
            }),
          );
          refs.push({ id, name: childName, qualifiedName: qn, filePath });
          containers.push({ id, start: child.getStart(), end: child.getEnd() });
          visit(child);
        }
        return;
      }
      node.forEachChild(visit);
      return;
    }

    if (ts.isCallExpression(node)) {
      const line = lineOf(node.getStart());
      const callee = node.expression;
      const arg0 = stringArg(node.arguments[0]);

      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (ROUTE_METHODS.has(method) && arg0?.startsWith("/")) {
          const upper = method.toUpperCase();
          const qn = `${upper} ${arg0}`;
          const id = routeId(repo.id, upper, arg0);
          nodes.push(
            makeNode(id, "route", qn, {
              qualifiedName: qn,
              startLine: line,
              endLine: lineOf(node.getEnd()),
              metadata: { method: upper, path: arg0 },
            }),
          );
          refs.push({ id, name: qn, qualifiedName: qn, filePath });
          containers.push({ id, start: node.getStart(), end: node.getEnd() });
          handlers.push({ containerId: id, ref: handlerRefOf(node.arguments[1]), line });
        } else if (method === "on" && arg0 !== null && node.arguments[1]) {
          const qn = `ws:${arg0}`;
          const id = apiOperationId(repo.id, qn);
          nodes.push(
            makeNode(id, "api_operation", qn, {
              qualifiedName: qn,
              startLine: line,
              endLine: lineOf(node.getEnd()),
              metadata: { kind: "websocket", event: arg0 },
            }),
          );
          refs.push({ id, name: arg0, qualifiedName: qn, filePath });
          containers.push({ id, start: node.getStart(), end: node.getEnd() });
          handlers.push({ containerId: id, ref: handlerRefOf(node.arguments[1]), line });
        } else if (ts.isIdentifier(callee.expression)) {
          rawCalls.push({
            node,
            info: { line, kind: "property", exprName: callee.expression.text, propName: method },
          });
        } else if (callee.expression.kind === ts.SyntaxKind.ThisKeyword && currentClass) {
          rawCalls.push({
            node,
            info: {
              line,
              kind: "this-property",
              propName: method,
              classQualifiedName: currentClass,
            },
          });
        }
      } else if (ts.isIdentifier(callee)) {
        rawCalls.push({ node, info: { line, kind: "identifier", name: callee.text } });
      }

      for (const arg of node.arguments) {
        const argText = stringArg(arg);
        if (!argText || !SQL_PATTERN.test(argText)) continue;
        const tableMatch = argText.match(SQL_TABLE_PATTERN);
        if (!tableMatch?.[1]) continue;
        const table = tableMatch[1];
        const tableId = databaseTableId(repo.id, table);
        if (!nodes.some((n) => n.id === tableId)) {
          nodes.push(
            makeNode(tableId, "database_table", table, {
              nodeFilePath: null,
              qualifiedName: table,
              metadata: { table },
            }),
          );
        }
        rawSql.push({
          node: arg,
          info: {
            table,
            mode: /^\s*SELECT/i.test(argText) ? "READS" : "WRITES",
            line,
            excerpt: argText.slice(0, 120),
          },
        });
      }

      node.forEachChild(visit);
      return;
    }

    node.forEachChild(visit);
  };

  try {
    visit(sf);
  } catch (err) {
    diagnostics.push({
      kind: "parse-error",
      message: err instanceof Error ? err.message : String(err),
      file: filePath,
    });
    return emptyResult(filePath, contentHash, nodes, declarations, refs, imports, diagnostics);
  }

  const calls: PendingCall[] = [];
  for (const raw of rawCalls) {
    const sourceId = findSourceId(raw.node.getStart());
    if (sourceId) calls.push({ sourceId, ...raw.info });
  }
  const sql: PendingSql[] = [];
  for (const raw of rawSql) {
    const sourceId = findSourceId(raw.node.getStart());
    if (sourceId) sql.push({ sourceId, ...raw.info });
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
    frontend,
    isTest,
    diagnostics,
  };
}

function emptyResult(
  filePath: string,
  contentHash: string,
  nodes: GraphNode[],
  declarations: Declaration[],
  refs: RefInfo[],
  imports: ImportBinding[],
  diagnostics: Diagnostic[],
): ExtractedFile {
  return {
    filePath,
    contentHash,
    nodes,
    declarations,
    refs,
    imports,
    calls: [],
    handlers: [],
    sql: [],
    frontend: [],
    isTest: false,
    diagnostics,
  };
}

function scriptKind(path: string): ts.ScriptKind {
  const ext = extOf(path);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export type ImportResolution =
  | { kind: "ok"; path: string }
  | { kind: "external" }
  | { kind: "not-found" }
  | { kind: "escape" };

export function resolveImport(
  repo: RepositoryContext,
  fromFile: string,
  specifier: string,
): ImportResolution {
  if (!specifier.startsWith(".")) return { kind: "external" };
  const clean = specifier.split(/[?#]/)[0]!;
  const base = normalize(join(dirname(fromFile), clean))
    .split("\\")
    .join("/");
  if (base.startsWith("..")) return { kind: "escape" };
  const candidates = [base];
  for (const ext of SUPPORTED_EXTENSIONS) candidates.push(base + ext, join(base, "index" + ext));
  for (const candidate of candidates) {
    const rel = candidate.split("\\").join("/");
    if (rel.split("/").some((seg) => IGNORED_DIRS.has(seg))) continue;
    if (!existsSync(join(repo.rootPath, rel))) continue;
    if (!SUPPORTED_EXTENSIONS.has(extOf(rel))) continue;
    return { kind: "ok", path: rel };
  }
  return { kind: "not-found" };
}

function extractEndpointMapping(node: ts.Expression): { method: string; path: string } | null {
  let obj: ts.ObjectLiteralExpression | null = null;
  if (ts.isObjectLiteralExpression(node)) obj = node;
  else if (ts.isCallExpression(node)) {
    const arg = node.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) obj = arg;
  }
  if (!obj) return null;
  let method: string | null = null;
  let path: string | null = null;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = prop.name.getText().replace(/^["']|["']$/g, "");
    const value = stringArgValue(prop.initializer);
    if (!value) continue;
    if (key === "operation" || key === "endpoint") {
      const match = value.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/i);
      if (match) {
        method = match[1]!.toUpperCase();
        path = match[2]!;
      } else if (value.startsWith("/")) {
        path = value;
      }
    } else if (key === "method") {
      method = value.toUpperCase();
    } else if (key === "path" || key === "url") {
      path = value;
    }
  }
  return method && path?.startsWith("/") ? { method, path } : null;
}

function stringArgValue(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}
