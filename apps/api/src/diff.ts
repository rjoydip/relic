/** Minimal snapshot shape shared by the export endpoint and `relic diff`. */
export interface SnapshotNodeLike {
  id: string;
  type?: string;
  name?: string;
  qualifiedName?: string | null;
  filePath?: string | null;
  startLine?: number | null;
  endLine?: number | null;
}

export interface SnapshotEdgeLike {
  id: string;
  type?: string;
  sourceId?: string;
  targetId?: string;
  confidence?: number;
}

export interface SnapshotLike {
  repository?: { name?: string; lastRevision?: string | null };
  nodes?: SnapshotNodeLike[];
  edges?: SnapshotEdgeLike[];
}

export interface SnapshotDiff {
  nodes: { added: SnapshotNodeLike[]; removed: SnapshotNodeLike[] };
  edges: { added: SnapshotEdgeLike[]; removed: SnapshotEdgeLike[] };
  /** true when either side differs — suitable for a CI drift check. */
  drift: boolean;
}

/** Identity-based comparison: a changed name/line is a remove + add. */
export function diffSnapshots(before: SnapshotLike, after: SnapshotLike): SnapshotDiff {
  const beforeNodes = new Map((before.nodes ?? []).map((node) => [node.id, node]));
  const afterNodes = new Map((after.nodes ?? []).map((node) => [node.id, node]));
  const beforeEdges = new Map((before.edges ?? []).map((edge) => [edge.id, edge]));
  const afterEdges = new Map((after.edges ?? []).map((edge) => [edge.id, edge]));

  const addedNodes = [...afterNodes.values()]
    .filter((node) => !beforeNodes.has(node.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const removedNodes = [...beforeNodes.values()]
    .filter((node) => !afterNodes.has(node.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const addedEdges = [...afterEdges.values()]
    .filter((edge) => !beforeEdges.has(edge.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const removedEdges = [...beforeEdges.values()]
    .filter((edge) => !afterEdges.has(edge.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes: { added: addedNodes, removed: removedNodes },
    edges: { added: addedEdges, removed: removedEdges },
    drift:
      addedNodes.length > 0 ||
      removedNodes.length > 0 ||
      addedEdges.length > 0 ||
      removedEdges.length > 0,
  };
}
