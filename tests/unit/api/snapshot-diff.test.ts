import { describe, expect, it } from "bun:test";
import { diffSnapshots } from "../../../apps/api/src/diff";

const snapshot = (nodes: string[], edges: string[] = []) => ({
  nodes: nodes.map((id) => ({ id, type: "symbol", name: id })),
  edges: edges.map((id) => ({ id, type: "CALLS", sourceId: "a", targetId: "b" })),
});

describe("snapshot diff", () => {
  it("lists added and removed nodes and edges", () => {
    const diff = diffSnapshots(
      snapshot(["a", "b"], ["e1", "gone"]),
      snapshot(["b", "c"], ["e1", "new"]),
    );
    expect(diff.nodes.added.map((n) => n.id)).toEqual(["c"]);
    expect(diff.nodes.removed.map((n) => n.id)).toEqual(["a"]);
    expect(diff.edges.added.map((e) => e.id)).toEqual(["new"]);
    expect(diff.edges.removed.map((e) => e.id)).toEqual(["gone"]);
    expect(diff.drift).toBe(true);
  });

  it("reports no drift for identical snapshots", () => {
    const diff = diffSnapshots(snapshot(["a"], ["e1"]), snapshot(["a"], ["e1"]));
    expect(diff.drift).toBe(false);
    expect(diff.nodes.added).toEqual([]);
    expect(diff.edges.removed).toEqual([]);
  });
});

describe("snapshot diff defaults", () => {
  it("treats missing node and edge arrays as empty", () => {
    const diff = diffSnapshots({}, { nodes: [{ id: "a" }], edges: [{ id: "e" }] });
    expect(diff.nodes.added.map((n) => n.id)).toEqual(["a"]);
    expect(diff.edges.added.map((e) => e.id)).toEqual(["e"]);
    expect(diff.nodes.removed).toEqual([]);
  });
});

describe("snapshot diff ordering", () => {
  it("sorts added and removed entries by id", () => {
    const diff = diffSnapshots(
      snapshot(["b", "a"], ["e2", "e1"]),
      snapshot(["d", "c"], ["e4", "e3"]),
    );
    expect(diff.nodes.added.map((n) => n.id)).toEqual(["c", "d"]);
    expect(diff.nodes.removed.map((n) => n.id)).toEqual(["a", "b"]);
    expect(diff.edges.added.map((e) => e.id)).toEqual(["e3", "e4"]);
    expect(diff.edges.removed.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});
