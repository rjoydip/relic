import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Diagnostic, GraphNode, NodeType } from "@relic/graph-core";
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

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const NEST_DECORATORS = new Set([
  "Get",
  "Post",
  "Put",
  "Patch",
  "Delete",
  "Head",
  "Options",
  "All",
]);

/** Next.js App Router route handler (app/.../route.ts) → "/users/:id". */
function nextAppRoutePath(filePath: string): string | null {
  const match = filePath.match(/(?:^|\/)(?:src\/)?app\/(.*\/)?route\.[cm]?[jt]sx?$/);
  if (!match) return null;
  return routePathFromSegments((match[1] ?? "").split("/").filter(Boolean));
}

/** Next.js Pages Router `pages/api/**` → "/api/health". */
function nextPagesRoutePath(filePath: string): string | null {
  const match = filePath.match(/(?:^|\/)(?:src\/)?pages\/api\/(.*)\.[cm]?[jt]sx?$/);
  if (!match) return null;
  const segments = match[1]!.split("/").filter(Boolean);
  if (segments[segments.length - 1] === "index") segments.pop();
  return routePathFromSegments(["api", ...segments]);
}

/** Next.js Pages Router page file → "/users/:id" (API and special files excluded). */
function nextPagesPagePath(filePath: string): string | null {
  const match = filePath.match(/(?:^|\/)(?:src\/)?pages\/(.*)\.[cm]?[jt]sx?$/);
  if (!match) return null;
  const segments = match[1]!.split("/").filter(Boolean);
  if (segments[0] === "api") return null;
  const file = segments.pop()!;
  if (file.startsWith("_")) return null;
  if (file !== "index") segments.push(file);
  return routePathFromSegments(segments);
}

function routePathFromSegments(segments: string[]): string {
  const path = segments
    .filter((segment) => !/^\(.+\)$/.test(segment)) // Next route groups "(marketing)"
    .map((segment) => {
      const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
      if (optionalCatchAll) return `*${optionalCatchAll[1]}`;
      const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
      if (catchAll) return `*${catchAll[1]}`;
      const dynamic = segment.match(/^\[(.+)\]$/);
      if (dynamic) return `:${dynamic[1]}`;
      return segment;
    });
  return `/${path.join("/")}`;
}

function hasDefaultModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (
    modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
    ) ?? false
  );
}

/** First decorator whose name is in `names`, with its first string argument. */
function decoratorMatch(
  node: ts.Node,
  names: Set<string>,
): { name: string; arg: string | null } | null {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (!decorators) return null;
  for (const decorator of decorators) {
    const expr = decorator.expression;
    const name = ts.isCallExpression(expr)
      ? ts.isIdentifier(expr.expression)
        ? expr.expression.text
        : ts.isPropertyAccessExpression(expr.expression)
          ? expr.expression.name.text
          : null
      : ts.isIdentifier(expr)
        ? expr.text
        : null;
    if (!name || !names.has(name)) continue;
    const argNode = ts.isCallExpression(expr) ? expr.arguments[0] : undefined;
    return { name, arg: argNode ? stringArgValue(argNode) : null };
  }
  return null;
}

function joinRoutePath(prefix: string | null, suffix: string | null): string {
  const parts = [prefix ?? "", suffix ?? ""]
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return `/${parts.join("/")}`;
}

/** tRPC: the terminal `.query` / `.mutation` / `.subscription` in a procedure chain. */
function trpcProcedureKind(expr: ts.Expression): "query" | "mutation" | "subscription" | null {
  let current: ts.Expression = expr;
  while (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (!ts.isPropertyAccessExpression(callee)) break;
    const name = callee.name.text;
    if (name === "query" || name === "mutation" || name === "subscription") return name;
    current = callee.expression;
  }
  return null;
}

function trpcResolver(expr: ts.Expression): ts.Expression | null {
  let current: ts.Expression = expr;
  while (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (!ts.isPropertyAccessExpression(callee)) break;
    const name = callee.name.text;
    if (name === "query" || name === "mutation" || name === "subscription") {
      return current.arguments[0] ?? null;
    }
    current = callee.expression;
  }
  return null;
}

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
  let currentControllerPrefix: string | null = null;
  const nextAppPath = nextAppRoutePath(filePath);
  const pagesRoutes: Array<{ method: string; path: string }> = [];
  const pagesApi = nextPagesRoutePath(filePath);
  if (pagesApi) pagesRoutes.push({ method: "ANY", path: pagesApi });
  const pagesPage = nextPagesPagePath(filePath);
  if (pagesPage) pagesRoutes.push({ method: "GET", path: pagesPage });

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
    exported = false,
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
        metadata: exported ? { kind, exported: true } : { kind },
      }),
    );
    refs.push({ id: decl.id, name: simpleName, qualifiedName, filePath });
    declarationIds.set(node, decl.id);
  };

  /** File- or decorator-derived route: node + EXPOSES handler target. */
  const addRoute = (
    method: string,
    path: string,
    node: ts.Node,
    metadata: Record<string, unknown>,
    handler?: HandlerRef,
    container?: { start: number; end: number },
  ): string => {
    const upper = method.toUpperCase();
    const qn = `${upper} ${path}`;
    const id = routeId(repo.id, upper, path);
    nodes.push(
      makeNode(id, "route", qn, {
        qualifiedName: qn,
        startLine: lineOf(node.getStart()),
        endLine: lineOf(node.getEnd()),
        metadata: { method: upper, path, ...metadata },
      }),
    );
    refs.push({ id, name: qn, qualifiedName: qn, filePath });
    if (container) containers.push({ id, ...container });
    if (handler) handlers.push({ containerId: id, ref: handler, line: lineOf(node.getStart()) });
    return id;
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
      const prevController = currentControllerPrefix;
      currentClass = node.name.text;
      const controller = decoratorMatch(node, new Set(["Controller"]));
      currentControllerPrefix = controller ? (controller.arg ?? "") : null;
      declare(node, node.name.text, node.name.text, "class", hasExportModifier(node));
      node.forEachChild(visit);
      currentClass = prevClass;
      currentControllerPrefix = prevController;
      return;
    }

    if (ts.isMethodDeclaration(node) && node.name && currentClass) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
          ? node.name.text
          : node.name.getText(sf);
      declare(node, name, `${currentClass}.${name}`, "method");
      if (currentControllerPrefix !== null) {
        const route = decoratorMatch(node, NEST_DECORATORS);
        if (route) {
          addRoute(
            route.name === "All" ? "ALL" : route.name,
            joinRoutePath(currentControllerPrefix, route.arg),
            node,
            { framework: "nestjs" },
            { kind: "identifier", name },
          );
        }
      }
      node.forEachChild(visit);
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      declare(node, node.name.text, node.name.text, "function", hasExportModifier(node));
      const name = node.name.text;
      if (nextAppPath && HTTP_METHODS.has(name.toUpperCase())) {
        addRoute(
          name.toUpperCase(),
          nextAppPath,
          node,
          { framework: "next-app" },
          {
            kind: "identifier",
            name,
          },
        );
      }
      if (pagesRoutes.length > 0 && hasDefaultModifier(node)) {
        for (const route of pagesRoutes) {
          addRoute(
            route.method,
            route.path,
            node,
            { framework: "next-pages" },
            {
              kind: "identifier",
              name,
            },
          );
        }
      }
      node.forEachChild(visit);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      const name = node.name.text;
      // Instance exports (`export const userService = new UserService()`) are
      // resolution targets for imports, so every named variable is declared.
      declare(node, name, name, "variable", hasExportModifier(node.parent?.parent ?? node));

      if (nextAppPath && HTTP_METHODS.has(name.toUpperCase())) {
        addRoute(
          name.toUpperCase(),
          nextAppPath,
          node,
          { framework: "next-app" },
          {
            kind: "identifier",
            name,
          },
        );
      }

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

    if (
      ts.isExportAssignment(node) &&
      !node.isExportEquals &&
      pagesRoutes.length > 0 &&
      !ts.isIdentifier(node.expression)
    ) {
      // `export default function () {}` is a FunctionDeclaration; this covers
      // `export default async (req, res) => {}` and `export default handler`.
      for (const route of pagesRoutes) {
        addRoute(route.method, route.path, node, { framework: "next-pages" }, undefined, {
          start: node.expression.getStart(),
          end: node.expression.getEnd(),
        });
      }
      node.forEachChild(visit);
      return;
    }

    if (ts.isExportAssignment(node) && !node.isExportEquals && pagesRoutes.length > 0) {
      for (const route of pagesRoutes) {
        addRoute(
          route.method,
          route.path,
          node,
          { framework: "next-pages" },
          {
            kind: "identifier",
            name: (node.expression as ts.Identifier).text,
          },
        );
      }
      node.forEachChild(visit);
      return;
    }

    if (ts.isCallExpression(node)) {
      const line = lineOf(node.getStart());
      const callee = node.expression;
      const arg0 = stringArg(node.arguments[0]);

      // tRPC: router({ getUser: publicProcedure.query(resolver) }) or t.router(...).
      const isRouterCall =
        (ts.isIdentifier(callee) && callee.text === "router") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "router");
      if (isRouterCall && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        for (const prop of node.arguments[0].properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const kind = trpcProcedureKind(prop.initializer);
          if (!kind) continue;
          const name = prop.name.getText(sf).replace(/^["']|["']$/g, "");
          const route = addRoute(kind.toUpperCase(), `/trpc/${name}`, prop, {
            framework: "trpc",
            procedure: kind,
          });
          const resolver = trpcResolver(prop.initializer);
          if (resolver && (ts.isArrowFunction(resolver) || ts.isFunctionExpression(resolver))) {
            declare(resolver, name, name, "function");
            containers.push({
              id: declarationIds.get(resolver)!,
              start: resolver.getStart(),
              end: resolver.getEnd(),
            });
            handlers.push({
              containerId: route,
              ref: { kind: "identifier", name },
              line,
            });
          } else if (resolver && ts.isIdentifier(resolver)) {
            handlers.push({
              containerId: route,
              ref: { kind: "identifier", name: resolver.text },
              line,
            });
          }
        }
      }

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
  const clean = specifier.split(/[?#]/)[0]!;
  if (clean.startsWith("/")) return { kind: "escape" };

  if (clean.startsWith(".")) {
    const base = normalize(join(dirname(fromFile), clean))
      .split("\\")
      .join("/");
    if (base.startsWith("..")) return { kind: "escape" };
    return probeImport(repo, base) ?? { kind: "not-found" };
  }

  // tsconfig `paths` — longest matching pattern wins, wildcard included.
  const alias = matchAlias(clean, repo.importConfig.paths);
  if (alias) {
    const baseDir = repo.importConfig.baseUrl ?? ".";
    for (const target of alias) {
      const rel = normalize(join(baseDir, target)).split("\\").join("/");
      if (rel.startsWith("..")) continue;
      const hit = probeImport(repo, rel);
      if (hit) return hit;
    }
    // Configured alias that points at nothing is a graph gap, not an npm package.
    return { kind: "not-found" };
  }

  // `baseUrl` makes bare specifiers resolve from the repo (e.g. "src/lib/x").
  if (repo.importConfig.baseUrl) {
    const rel = normalize(join(repo.importConfig.baseUrl, clean)).split("\\").join("/");
    if (!rel.startsWith("..")) {
      const hit = probeImport(repo, rel);
      if (hit) return hit;
    }
  }

  // Workspace sibling: "@scope/pkg" or "@scope/pkg/subpath".
  const workspace = matchWorkspace(clean, repo.importConfig.workspaces);
  if (workspace) {
    const bases = workspace.subpath
      ? [join(workspace.dir, workspace.subpath), join(workspace.dir, "src", workspace.subpath)]
      : [join(workspace.dir, "src/index"), join(workspace.dir, "index")];
    for (const base of bases) {
      const hit = probeImport(repo, normalize(base).split("\\").join("/"));
      if (hit) return hit;
    }
    // An indexed workspace package that cannot be entered is a diagnostic-worthy gap.
    return { kind: "not-found" };
  }

  return { kind: "external" };
}

function probeImport(repo: RepositoryContext, base: string): ImportResolution | null {
  const candidates = [base];
  for (const ext of SUPPORTED_EXTENSIONS) candidates.push(base + ext, `${base}/index${ext}`);
  for (const candidate of candidates) {
    const rel = candidate.split("\\").join("/");
    if (rel.startsWith("..") || rel.split("/").includes("..")) continue;
    if (rel.split("/").some((seg) => IGNORED_DIRS.has(seg))) continue;
    if (!existsSync(join(repo.rootPath, rel))) continue;
    if (!SUPPORTED_EXTENSIONS.has(extOf(rel))) continue;
    return { kind: "ok", path: rel };
  }
  return null;
}

/** Expand a tsconfig `paths` pattern into target templates, or null when none match. */
function matchAlias(specifier: string, paths: Record<string, string[]>): string[] | null {
  let best: { prefixLength: number; star: number; pattern: string; targets: string[] } | null =
    null;
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf("*");
    const prefix = star < 0 ? pattern : pattern.slice(0, star);
    const suffix = star < 0 ? "" : pattern.slice(star + 1);
    const matches =
      star < 0
        ? specifier === pattern
        : specifier.startsWith(prefix) &&
          specifier.endsWith(suffix) &&
          specifier.length >= prefix.length + suffix.length;
    if (!matches) continue;
    if (!best || prefix.length > best.prefixLength) {
      best = { prefixLength: prefix.length, star, pattern, targets };
    }
  }
  if (!best) return null;
  if (best.star < 0) return best.targets;
  const suffixLength = best.pattern.length - best.star - 1;
  const middle = specifier.slice(best.star, specifier.length - suffixLength);
  return best.targets.map((target) => target.replace("*", middle));
}

function matchWorkspace(
  specifier: string,
  workspaces: Map<string, string>,
): { dir: string; subpath: string } | null {
  let best: string | null = null;
  for (const name of workspaces.keys()) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      if (!best || name.length > best.length) best = name;
    }
  }
  if (!best) return null;
  return { dir: workspaces.get(best)!, subpath: specifier.slice(best.length + 1) };
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
