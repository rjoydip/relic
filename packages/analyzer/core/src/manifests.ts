import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { EdgeType, Evidence, GraphEdge, GraphNode } from "@relic/graph-core";
import { CONFIDENCE } from "@relic/graph-core";
import { IGNORED_DIRS, extOf, sha1 } from "./discovery";
import type { RepositoryContext } from "./discovery";
import { deploymentId, edgeId, fileId, repositoryNodeId, serviceId } from "./ids";

export interface ManifestGraph {
  filePath: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Manifest files whose contents describe services, deployments or queues. */
export function walkManifestFiles(rootPath: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(full);
        continue;
      }
      const rel = relative(rootPath, full).split(sep).join("/");
      if (isManifestName(entry.name) || isKubernetesManifest(full, entry.name)) out.push(rel);
    }
  };
  visit(rootPath);
  return out.sort();
}

function isManifestName(name: string): boolean {
  return (
    /^dockerfile(\..+)?$/i.test(name) ||
    /\.dockerfile$/i.test(name) ||
    /^(docker-)?compose(\.[^.]+)?\.ya?ml$/i.test(name)
  );
}

function isKubernetesManifest(full: string, name: string): boolean {
  if (!/\.ya?ml$/i.test(name)) return false;
  try {
    if (statSync(full).size > 1_000_000) return false;
    const text = readFileSync(full, "utf8");
    return /^\s*apiVersion\s*:/m.test(text) && /^\s*kind\s*:/m.test(text);
  } catch {
    return false;
  }
}

export function extractManifest(repo: RepositoryContext, filePath: string): ManifestGraph {
  const text = readFileSync(join(repo.rootPath, filePath), "utf8");
  const now = new Date().toISOString();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const fileNodeId = fileId(repo.id, filePath);

  const node = (
    id: string,
    type: "service" | "deployment",
    name: string,
    metadata: Record<string, unknown>,
    line?: number,
  ): GraphNode => {
    const graphNode: GraphNode = {
      id,
      repositoryId: repo.id,
      type,
      name,
      qualifiedName: name,
      filePath,
      startLine: line ?? null,
      endLine: line ?? null,
      metadata: { ...metadata, manifest: filePath },
      contentHash: null,
      updatedAt: now,
    };
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push(graphNode);
    }
    return graphNode;
  };

  const edge = (sourceId: string, targetId: string, line?: number, note?: string): void => {
    if (sourceId === targetId) return;
    const key = `${sourceId}|${targetId}|DEPENDS_ON`;
    if (seen.has(key)) return;
    seen.add(key);
    const evidence: Evidence = { source: "static", file: filePath, ...(line ? { line } : {}) };
    if (note) evidence.note = note;
    edges.push({
      id: edgeId(sourceId, targetId, "DEPENDS_ON"),
      repositoryId: repo.id,
      sourceId,
      targetId,
      type: "DEPENDS_ON",
      confidence: CONFIDENCE.static,
      evidence,
    });
  };

  nodes.push({
    id: repositoryNodeId(repo.id),
    repositoryId: repo.id,
    type: "repository",
    name: repo.name,
    qualifiedName: null,
    filePath: null,
    startLine: null,
    endLine: null,
    metadata: {},
    contentHash: null,
    updatedAt: now,
  });
  nodes.push({
    id: fileNodeId,
    repositoryId: repo.id,
    type: "file",
    name: filePath,
    qualifiedName: null,
    filePath,
    startLine: null,
    endLine: null,
    metadata: { manifest: true },
    contentHash: sha1(text),
    updatedAt: now,
  });
  const structural = (targetId: string, type: "CONTAINS" | "DECLARES", line?: number): void => {
    const sourceId = type === "CONTAINS" ? repositoryNodeId(repo.id) : fileNodeId;
    const key = `${sourceId}|${targetId}|${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    const evidence: Evidence = { source: "static", file: filePath };
    if (line) evidence.line = line;
    edges.push({
      id: edgeId(sourceId, targetId, type),
      repositoryId: repo.id,
      sourceId,
      targetId,
      type,
      confidence: CONFIDENCE.static,
      evidence,
    });
  };
  structural(fileNodeId, "CONTAINS");

  const name = filePath.split("/").pop() ?? filePath;
  if (/^dockerfile|\.dockerfile$/i.test(name)) {
    extractDockerfile(repo, text, filePath, node, edge, structural);
  } else if (/^(docker-)?compose/i.test(name)) {
    extractCompose(repo, text, filePath, node, edge, structural);
  } else {
    extractKubernetes(repo, text, filePath, node, edge, structural);
  }

  return { filePath, nodes, edges };
}

type NodeFactory = (
  id: string,
  type: "service" | "deployment",
  name: string,
  metadata: Record<string, unknown>,
  line?: number,
) => GraphNode;
type EdgeFactory = (sourceId: string, targetId: string, line?: number, note?: string) => void;
type StructuralFactory = (targetId: string, type: "CONTAINS" | "DECLARES", line?: number) => void;

function extractCompose(
  repo: RepositoryContext,
  text: string,
  filePath: string,
  node: NodeFactory,
  edge: EdgeFactory,
  structural: StructuralFactory,
): void {
  const lines = text.split(/\r?\n/);
  let inServices = false;
  let current: GraphNode | null = null;
  let currentIndent = 0;
  let dependsOn = false;
  const services = new Map<string, GraphNode>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*services\s*:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices || /^\s*#/.test(line) || line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && !/^\s*services\s*:/.test(line)) {
      inServices = false;
      current = null;
      continue;
    }

    const serviceName = /^(\s{2,})([A-Za-z0-9_.-]+)\s*:\s*$/.exec(line);
    if (serviceName?.[2] && (current === null || indent <= currentIndent)) {
      const id = serviceId(repo.id, serviceName[2]);
      current = services.get(id) ?? node(id, "service", serviceName[2], { kind: "service" }, i + 1);
      services.set(id, current);
      structural(id, "DECLARES", i + 1);
      currentIndent = indent;
      dependsOn = false;
      continue;
    }
    if (!current) continue;

    const image = /^\s+image\s*:\s*(\S+)/.exec(line);
    if (image?.[1]) current.metadata = { ...current.metadata, image: image[1] };

    if (/^\s+depends_on\s*:/.test(line)) {
      dependsOn = true;
      continue;
    }
    if (dependsOn) {
      const dep = /^\s*-\s*([A-Za-z0-9_.-]+)\s*$/.exec(line);
      if (dep?.[1]) {
        const targetId = serviceId(repo.id, dep[1]);
        const target =
          services.get(targetId) ??
          node(targetId, "service", dep[1], { kind: "service", implicit: true }, i + 1);
        services.set(targetId, target);
        structural(targetId, "DECLARES", i + 1);
        edge(current.id, targetId, i + 1, `compose depends_on ${dep[1]}`);
      } else if (!/^\s+/.test(line)) {
        dependsOn = false;
      }
    }
  }
}

function extractKubernetes(
  repo: RepositoryContext,
  text: string,
  filePath: string,
  node: NodeFactory,
  edge: EdgeFactory,
  structural: StructuralFactory,
): void {
  const docs = text.split(/^---\s*$/m);
  let offset = 0;
  for (const doc of docs) {
    const docLines = doc.split(/\r?\n/);
    const kind = /^\s*kind\s*:\s*([A-Za-z]+)/m.exec(doc)?.[1];
    const name = /^\s{2}name\s*:\s*([A-Za-z0-9_.-]+)/m.exec(doc)?.[1];
    if (!kind || !name) {
      offset += docLines.length;
      continue;
    }
    const type =
      kind === "Service" || kind === "ConfigMap" || kind === "Secret" || kind === "ServiceAccount"
        ? "service"
        : kind === "Deployment" ||
            kind === "StatefulSet" ||
            kind === "DaemonSet" ||
            kind === "Job" ||
            kind === "CronJob" ||
            kind === "Pod"
          ? "deployment"
          : null;
    if (!type) {
      offset += docLines.length;
      continue;
    }
    const id = type === "service" ? serviceId(repo.id, name) : deploymentId(repo.id, name);
    const line = offset + Math.max(1, docLines.findIndex((l) => l.includes(name)) + 1);
    const graphNode = node(id, type, name, { kind, kubernetes: true }, line);
    structural(id, "DECLARES", line);

    const images = doc.matchAll(/^\s*image\s*:\s*(\S+)/gm);
    for (const match of images) {
      const image = match[1]!;
      const imageId = serviceId(repo.id, image);
      node(imageId, "service", image, { kind: "image", external: true }, line);
      structural(imageId, "DECLARES", line);
      edge(graphNode.id, imageId, line, `image ${image}`);
    }
    const serviceAccount = /^\s*serviceAccountName\s*:\s*([A-Za-z0-9_.-]+)/m.exec(doc)?.[1];
    if (serviceAccount) {
      const accountId = serviceId(repo.id, serviceAccount);
      node(accountId, "service", serviceAccount, { kind: "service_account" }, line);
      structural(accountId, "DECLARES", line);
      edge(graphNode.id, accountId, line, `serviceAccountName ${serviceAccount}`);
    }
    offset += docLines.length;
  }
  void filePath;
}

function extractDockerfile(
  repo: RepositoryContext,
  text: string,
  filePath: string,
  node: NodeFactory,
  edge: EdgeFactory,
  structural: StructuralFactory,
): void {
  const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const name = dir.split("/").pop() || "root";
  const id = deploymentId(repo.id, name);
  const graphNode = node(id, "deployment", name, { kind: "deployment", dockerfile: filePath }, 1);
  structural(id, "DECLARES", 1);

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const from = /^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from?.[1]) {
      const imageId = serviceId(repo.id, from[1]);
      node(
        imageId,
        "service",
        from[1],
        { kind: "image", external: true, stage: from[2] ?? null },
        i + 1,
      );
      structural(imageId, "DECLARES", i + 1);
      edge(graphNode.id, imageId, i + 1, `FROM ${from[1]}`);
    }
    const copyFrom = /^\s*COPY\s+--from=(\S+)/i.exec(line);
    if (copyFrom?.[1] && copyFrom[1] !== "0") {
      const stageId = deploymentId(repo.id, `${name}:${copyFrom[1]}`);
      node(stageId, "deployment", `${name}:${copyFrom[1]}`, { kind: "build_stage" }, i + 1);
      structural(stageId, "DECLARES", i + 1);
      edge(graphNode.id, stageId, i + 1, `COPY --from=${copyFrom[1]}`);
    }
  }
}

/** Kept for callers that need the extension check without importing discovery internals. */
export function isManifestPath(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  if (isManifestName(base)) return true;
  return /\.ya?ml$/i.test(base);
}

/** Export for tests that need to know a candidate's extension. */
export function manifestExtension(filePath: string): string {
  return extOf(filePath);
}

export type { EdgeType };
