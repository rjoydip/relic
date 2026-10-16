import type { Diagnostic, EdgeType, Evidence, GraphEdge } from "@mcpdg/graph-core";
import { CONFIDENCE } from "@mcpdg/graph-core";
import type { ExtractedFile, RefInfo, RefLookup } from "./extract";
import type { RepositoryContext } from "./discovery";
import { databaseTableId, edgeId, fileId, repositoryNodeId, routeId } from "./ids";

export interface RelationResult {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

/**
 * Pass 2: connect declarations, imports, calls, routes, tests, SQL and
 * frontend operations using fresh declarations + the shared ref lookup.
 * Name-exact static resolutions get confidence 1.0; property calls resolved
 * through import bindings by name are explicitly marked inferred (0.6).
 */
export function relate(
  repo: RepositoryContext,
  extracted: ExtractedFile,
  lookup: RefLookup,
): RelationResult {
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [...extracted.diagnostics];
  const seen = new Set<string>();
  const filePath = extracted.filePath;

  const addEdge = (
    sourceId: string,
    targetId: string,
    type: EdgeType,
    evidence: Evidence,
  ): void => {
    if (sourceId === targetId && type !== "DECLARES") return;
    const key = `${sourceId}|${targetId}|${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      id: edgeId(sourceId, targetId, type),
      repositoryId: repo.id,
      sourceId,
      targetId,
      type,
      confidence: CONFIDENCE[evidence.source],
      evidence,
    });
  };

  const localDecls = extracted.declarations;

  const findExact = (name: string, targetFile: string | null): RefInfo | null => {
    if (targetFile === filePath) {
      const local = localDecls.find((d) => d.simpleName === name);
      if (local)
        return {
          id: local.id,
          name: local.simpleName,
          qualifiedName: local.qualifiedName,
          filePath,
        };
    }
    const candidates = lookup.findByName(name).filter((r) => r.filePath === targetFile);
    return candidates.find((r) => r.name === name) ?? candidates[0] ?? null;
  };

  const findLoose = (name: string, targetFile: string): RefInfo | null => {
    if (targetFile === filePath) {
      const local = localDecls.find(
        (d) => d.simpleName === name || d.qualifiedName.endsWith(`.${name}`),
      );
      if (local)
        return {
          id: local.id,
          name: local.simpleName,
          qualifiedName: local.qualifiedName,
          filePath,
        };
    }
    const candidates = lookup.findByName(name).filter((r) => r.filePath === targetFile);
    return (
      candidates.find((r) => r.name === name || r.qualifiedName === name) ??
      candidates.find((r) => r.qualifiedName.endsWith(`.${name}`)) ??
      null
    );
  };

  // Structural edges.
  addEdge(repositoryNodeId(repo.id), fileId(repo.id, filePath), "CONTAINS", {
    source: "static",
    file: filePath,
  });
  for (const decl of localDecls) {
    addEdge(fileId(repo.id, filePath), decl.id, "DECLARES", {
      source: "static",
      file: filePath,
      line: decl.startLine,
    });
  }
  for (const imp of extracted.imports) {
    if (!imp.targetFile) continue;
    addEdge(fileId(repo.id, filePath), fileId(repo.id, imp.targetFile), "IMPORTS", {
      source: "static",
      file: filePath,
    });
  }

  // Calls.
  for (const call of extracted.calls) {
    const evidence = (source: Evidence["source"], note?: string): Evidence => {
      const e: Evidence = { source, file: filePath, line: call.line };
      if (note) e.note = note;
      return e;
    };
    if (call.kind === "identifier") {
      const local = localDecls.find((d) => d.simpleName === call.name);
      if (local) {
        addEdge(call.sourceId, local.id, "CALLS", evidence("static"));
        continue;
      }
      const binding = extracted.imports.find((i) => i.localName === call.name);
      if (!binding?.targetFile) continue; // global or external (describe/expect/console…)
      const target = findExact(binding.exportName, binding.targetFile);
      if (target) addEdge(call.sourceId, target.id, "CALLS", evidence("static"));
      else
        diagnostics.push({
          kind: "unresolved",
          message: `Cannot resolve call to "${call.name}"`,
          file: filePath,
          line: call.line,
        });
      continue;
    }
    if (call.kind === "property") {
      const binding = extracted.imports.find((i) => i.localName === call.exprName);
      if (!binding?.targetFile) continue; // local object literal or external namespace
      const target = findLoose(call.propName!, binding.targetFile);
      if (target) {
        addEdge(
          call.sourceId,
          target.id,
          "CALLS",
          evidence(
            "inferred",
            `property call "${call.exprName}.${call.propName}" resolved by name`,
          ),
        );
      } else {
        diagnostics.push({
          kind: "unresolved",
          message: `Cannot resolve "${call.exprName}.${call.propName}" in ${binding.targetFile}`,
          file: filePath,
          line: call.line,
        });
      }
      continue;
    }
    if (call.kind === "this-property") {
      const local = localDecls.find(
        (d) => d.qualifiedName === `${call.classQualifiedName}.${call.propName}`,
      );
      if (local) addEdge(call.sourceId, local.id, "CALLS", evidence("static"));
      // else: inherited or external member — not reported as an unresolved graph fact.
    }
  }

  // Route / WebSocket operation handlers.
  for (const handler of extracted.handlers) {
    const mkEvidence = (source: Evidence["source"], note?: string): Evidence => {
      const e: Evidence = { source, file: filePath, line: handler.line };
      if (note) e.note = note;
      return e;
    };
    if (handler.ref.kind === "identifier") {
      const name = handler.ref.name!;
      const local = localDecls.find((d) => d.simpleName === name);
      if (local) {
        addEdge(handler.containerId, local.id, "EXPOSES", mkEvidence("static"));
        continue;
      }
      const binding = extracted.imports.find((i) => i.localName === name);
      const target = binding
        ? findExact(binding.exportName, binding.targetFile)
        : findExact(name, null);
      if (target) addEdge(handler.containerId, target.id, "EXPOSES", mkEvidence("static"));
      else
        diagnostics.push({
          kind: "unresolved",
          message: `Cannot resolve handler "${name}"`,
          file: filePath,
          line: handler.line,
        });
      continue;
    }
    if (handler.ref.kind === "property") {
      const binding = extracted.imports.find((i) => i.localName === handler.ref.exprName);
      const targetFile = binding?.targetFile ?? filePath;
      const target = findLoose(handler.ref.propName!, targetFile);
      if (target) {
        addEdge(
          handler.containerId,
          target.id,
          "EXPOSES",
          mkEvidence(
            "inferred",
            `handler "${handler.ref.exprName}.${handler.ref.propName}" resolved by name`,
          ),
        );
      } else {
        diagnostics.push({
          kind: "unresolved",
          message: `Cannot resolve handler "${handler.ref.exprName}.${handler.ref.propName}"`,
          file: filePath,
          line: handler.line,
        });
      }
    }
    // Inline handlers: body calls attach to the container directly.
  }

  // Tests: imports of test files and resolved calls inside tests.
  if (extracted.isTest) {
    const testNode = extracted.nodes.find((n) => n.type === "test");
    if (testNode) {
      for (const imp of extracted.imports) {
        if (!imp.targetFile) continue;
        const target = findExact(imp.exportName, imp.targetFile);
        if (target) addEdge(testNode.id, target.id, "TESTS", { source: "static", file: filePath });
      }
      for (const call of extracted.calls) {
        let targetId: string | null = null;
        if (call.kind === "identifier") {
          const local = localDecls.find((d) => d.simpleName === call.name);
          if (local) targetId = local.id;
          else {
            const binding = extracted.imports.find((i) => i.localName === call.name);
            if (binding?.targetFile)
              targetId = findExact(binding.exportName, binding.targetFile)?.id ?? null;
          }
        } else if (call.kind === "property") {
          const binding = extracted.imports.find((i) => i.localName === call.exprName);
          if (binding?.targetFile)
            targetId = findLoose(call.propName!, binding.targetFile)?.id ?? null;
        }
        if (targetId)
          addEdge(testNode.id, targetId, "TESTS", {
            source: "static",
            file: filePath,
            line: call.line,
          });
      }
    }
  }

  // SQL data access.
  for (const item of extracted.sql) {
    addEdge(item.sourceId, databaseTableId(repo.id, item.table), item.mode, {
      source: "static",
      file: filePath,
      line: item.line,
      note: item.excerpt,
    });
  }

  // Frontend operations → routes via explicit endpoint mapping.
  for (const fe of extracted.frontend) {
    const routeTarget = lookup.findByName(`${fe.method} ${fe.path}`)[0];
    const note = `endpoint mapping ${fe.method} ${fe.path}`;
    if (routeTarget) {
      addEdge(fe.nodeId, routeTarget.id, "USES_OPERATION", {
        source: "inferred",
        file: filePath,
        line: fe.line,
        note,
      });
    } else {
      // Route not indexed yet: emit against the stable computed id; the
      // persist phase drops it if the route node does not exist.
      addEdge(fe.nodeId, routeId(repo.id, fe.method, fe.path), "USES_OPERATION", {
        source: "inferred",
        file: filePath,
        line: fe.line,
        note,
      });
      diagnostics.push({
        kind: "unresolved",
        message: `No route for ${fe.method} ${fe.path}`,
        file: filePath,
        line: fe.line,
      });
    }
  }

  return { edges, diagnostics };
}
