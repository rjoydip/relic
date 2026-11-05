import type { GraphEdge, GraphNode } from "@relic/graph-core";

export type ExportFormat = "mermaid" | "dot";

function label(node: GraphNode): string {
  return `${node.qualifiedName ?? node.name} (${node.type})`;
}

function mermaidLabel(node: GraphNode): string {
  return label(node).replace(/"/g, "&quot;").replace(/\r?\n/g, " ");
}

function dotLabel(node: GraphNode): string {
  return label(node).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

/** Mermaid flowchart for docs and PR descriptions. */
export function toMermaid(nodes: GraphNode[], edges: GraphEdge[]): string {
  const ids = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ["flowchart LR"];
  for (const node of nodes) {
    lines.push(`  ${ids.get(node.id)}["${mermaidLabel(node)}"]`);
  }
  for (const edge of edges) {
    const source = ids.get(edge.sourceId);
    const target = ids.get(edge.targetId);
    if (source && target) lines.push(`  ${source} -->|${edge.type}| ${target}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Graphviz DOT for rendering with dot/Graphviz. */
export function toDot(nodes: GraphNode[], edges: GraphEdge[]): string {
  const ids = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ["digraph relic {", "  rankdir=LR;"];
  for (const node of nodes) {
    lines.push(`  ${ids.get(node.id)} [label="${dotLabel(node)}"];`);
  }
  for (const edge of edges) {
    const source = ids.get(edge.sourceId);
    const target = ids.get(edge.targetId);
    if (source && target) lines.push(`  ${source} -> ${target} [label="${edge.type}"];`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function exportGraph(format: ExportFormat, nodes: GraphNode[], edges: GraphEdge[]): string {
  return format === "dot" ? toDot(nodes, edges) : toMermaid(nodes, edges);
}
