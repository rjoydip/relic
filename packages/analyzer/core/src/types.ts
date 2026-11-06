import type { Diagnostic, GraphNode } from "@relic/graph-core";

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
  /** Raw module specifier, retained for cross-repository resolution. */
  specifier?: string;
  /** Target repository when the import crosses an indexed repository boundary. */
  targetRepositoryId?: string;
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

/** A publish/subscribe call observed at extraction time. */
export interface PendingMessage {
  sourceId: string;
  queue: string;
  mode: "PUBLISHES" | "CONSUMES";
  line: number;
  excerpt: string;
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
  messages: PendingMessage[];
  isTest: boolean;
  diagnostics: Diagnostic[];
}

export interface RefLookup {
  findByName(name: string): RefInfo[];
}
