import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Diagnostic, GraphEdge, GraphRepository } from "@relic/graph-core";
import { CONFIDENCE } from "@relic/graph-core";

export interface RuntimeObservation {
  file: string;
  line: number;
  hits: number;
  functionName?: string;
  source: "lcov" | "otel";
}

export interface RuntimeReport {
  observations: number;
  upgraded: number;
  conflicts: number;
  unmatched: number;
  diagnostics: Diagnostic[];
}

const COVERAGE_EDGE_TYPES = new Set(["CALLS", "TESTS"]);

/** Parse lcov `DA:`/`FNDA:` records into per-line observations. */
export function parseLcov(text: string): RuntimeObservation[] {
  const observations: RuntimeObservation[] = [];
  let file: string | null = null;
  let functions = new Map<string, { line: number; hits: number }>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      file = line.slice(3).trim();
      functions = new Map();
      continue;
    }
    if (!file) continue;
    if (line.startsWith("FN:")) {
      const [lineNumber, ...name] = line.slice(3).split(",");
      const parsed = Number(lineNumber);
      if (Number.isFinite(parsed) && name.length > 0)
        functions.set(name.join(","), { line: parsed, hits: 0 });
      continue;
    }
    if (line.startsWith("FNDA:")) {
      const [count, ...name] = line.slice(5).split(",");
      const key = name.join(",");
      const fn = functions.get(key);
      if (fn && Number.isFinite(Number(count))) fn.hits = Number(count);
      continue;
    }
    if (line.startsWith("DA:")) {
      const [lineNumber, count] = line.slice(3).split(",");
      const parsed = Number(lineNumber);
      if (!Number.isFinite(parsed)) continue;
      observations.push({
        file,
        line: parsed,
        hits: Number(count ?? 0),
        source: "lcov",
      });
      continue;
    }
    if (line === "end_of_record") {
      for (const [name, fn] of functions) {
        if (fn.hits > 0)
          observations.push({
            file,
            line: fn.line,
            hits: fn.hits,
            functionName: name,
            source: "lcov",
          });
      }
      file = null;
      functions = new Map();
    }
  }
  return observations;
}

interface OtelAttribute {
  key?: string;
  value?: { stringValue?: string; intValue?: number | string; boolValue?: boolean };
}

interface OtelSpan {
  name?: string;
  attributes?: OtelAttribute[];
  filepath?: string;
  lineno?: number;
  functionName?: string;
}

/** Parse OTLP JSON or a flat `{ spans: [...] }` export. */
export function parseOtel(text: string): RuntimeObservation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const spans: OtelSpan[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.spans)) {
      for (const span of record.spans) if (span && typeof span === "object") spans.push(span);
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(parsed);

  const observations: RuntimeObservation[] = [];
  for (const span of spans) {
    const attrs = new Map<string, string>();
    for (const attr of span.attributes ?? []) {
      if (!attr.key) continue;
      const value = attr.value?.stringValue ?? attr.value?.intValue ?? attr.value?.boolValue;
      if (value !== undefined) attrs.set(attr.key, String(value));
    }
    const file = span.filepath ?? attrs.get("code.filepath") ?? attrs.get("code.file.path");
    const rawLine = span.lineno ?? attrs.get("code.lineno") ?? attrs.get("code.line.number");
    const line = Number(rawLine);
    const functionName =
      span.functionName ?? attrs.get("code.function") ?? attrs.get("code.function.name");
    if (!file) continue;
    if (!Number.isFinite(line) || line <= 0) {
      if (!functionName) continue;
      observations.push({ file, line: 0, hits: 1, functionName, source: "otel" });
      continue;
    }
    observations.push({
      file,
      line,
      hits: 1,
      ...(functionName ? { functionName } : {}),
      source: "otel",
    });
  }
  return observations;
}

/** Apply observations as an evidence upgrade; static conflicts are reported, never deleted. */
export function applyRuntimeEvidence(
  repository: GraphRepository,
  repositoryId: string,
  observations: RuntimeObservation[],
  rootPath: string,
): RuntimeReport {
  const diagnostics: Diagnostic[] = [];
  const edges = repository
    .getEdges({ repositoryId, edgeTypes: ["CALLS", "TESTS"], limit: 100_000 })
    .filter((edge) => COVERAGE_EDGE_TYPES.has(edge.type));
  const byLine = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    if (!edge.evidence.file || edge.evidence.line == null) continue;
    const key = `${normalizeFile(edge.evidence.file, rootPath)}:${edge.evidence.line}`;
    const bucket = byLine.get(key);
    if (bucket) bucket.push(edge);
    else byLine.set(key, [edge]);
  }

  let upgraded = 0;
  let conflicts = 0;
  let unmatched = 0;
  const seen = new Set<string>();
  for (const observation of observations) {
    const file = normalizeFile(observation.file, rootPath);
    const key = `${file}:${observation.line}`;
    const matched = byLine.get(key) ?? [];
    if (matched.length === 0) {
      unmatched++;
      continue;
    }
    for (const edge of matched) {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      if (observation.hits <= 0 && edge.evidence.source === "static") {
        conflicts++;
        diagnostics.push({
          kind: "runtime-conflict",
          message: `Static ${edge.type} edge was not observed by ${observation.source}`,
          file,
          line: observation.line,
        });
        continue;
      }
      if (observation.hits <= 0) continue;
      if (edge.evidence.source === "runtime") continue;
      repository.upsertEdge({
        ...edge,
        confidence: CONFIDENCE.runtime,
        evidence: {
          source: "runtime",
          file,
          line: observation.line,
          note: `observed by ${observation.source}${observation.functionName ? ` (${observation.functionName})` : ""}`,
        },
      });
      upgraded++;
    }
  }

  const meta = repository.getRepository(repositoryId);
  if (meta) {
    const merged = dedupe([...meta.diagnostics, ...diagnostics]);
    if (merged.length !== meta.diagnostics.length || diagnostics.length > 0) {
      repository.upsertRepository({ ...meta, diagnostics: merged });
    }
  }
  return { observations: observations.length, upgraded, conflicts, unmatched, diagnostics };
}

/** Ingest a file's contents; CLI/API share this entry point. */
export function ingestRuntime(
  repository: GraphRepository,
  repositoryId: string,
  format: "lcov" | "otel",
  content: string,
  rootPath: string,
): RuntimeReport {
  return applyRuntimeEvidence(
    repository,
    repositoryId,
    format === "lcov" ? parseLcov(content) : parseOtel(content),
    rootPath,
  );
}

export function readRuntimeFile(path: string): { format: "lcov" | "otel"; content: string } {
  const content = readFileSync(resolve(path), "utf8");
  const format = /^\s*(?:\{|\[)/.test(content) ? "otel" : "lcov";
  return { format, content };
}

function normalizeFile(file: string, rootPath: string): string {
  const root = resolve(rootPath).replace(/\\/g, "/");
  const normalized = file.replace(/\\/g, "/");
  if (!isAbsolute(file)) return normalized.replace(/^\.\//, "");
  const absolute = resolve(file).replace(/\\/g, "/");
  return absolute.startsWith(root + "/") ? absolute.slice(root.length + 1) : absolute;
}

function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.kind}|${diagnostic.message}|${diagnostic.file ?? ""}|${diagnostic.line ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
