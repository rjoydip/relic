import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  applyRuntimeEvidence,
  ingestRuntime,
  openGraph,
  parseLcov,
  parseOtel,
  readRuntimeFile,
  repositoryIdFor,
  type OpenGraph,
} from "@relic/indexer";
import { cleanup, copyFixture, tempDir } from "../../helpers";

describe("runtime evidence parsers", () => {
  it("reads lcov line and function coverage", () => {
    const observations = parseLcov(
      [
        "SF:src/user.ts",
        "FN:4,updateUser",
        "FNDA:2,updateUser",
        "DA:4,2",
        "DA:5,0",
        "end_of_record",
      ].join("\n"),
    );
    expect(observations).toContainEqual(
      expect.objectContaining({ file: "src/user.ts", line: 4, hits: 2 }),
    );
    expect(observations).toContainEqual(
      expect.objectContaining({ file: "src/user.ts", line: 5, hits: 0 }),
    );
    expect(observations.some((o) => o.functionName === "updateUser" && o.source === "lcov")).toBe(
      true,
    );
  });

  it("reads OTLP JSON spans with code attributes", () => {
    const observations = parseOtel(
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    name: "updateUser",
                    attributes: [
                      { key: "code.filepath", value: { stringValue: "src/user.ts" } },
                      { key: "code.lineno", value: { intValue: 7 } },
                      { key: "code.function", value: { stringValue: "updateUser" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(observations).toEqual([
      expect.objectContaining({ file: "src/user.ts", line: 7, hits: 1, source: "otel" }),
    ]);
  });

  it("handles malformed and function-only OTLP input", () => {
    expect(parseOtel("not json")).toEqual([]);
    expect(parseOtel("null")).toEqual([]);
    const observations = parseOtel(
      JSON.stringify({
        spans: [
          { name: "no file", attributes: [] },
          {
            attributes: [
              { key: "code.file.path", value: { stringValue: "src/a.ts" } },
              { key: "code.function.name", value: { stringValue: "alpha" } },
            ],
          },
        ],
      }),
    );
    expect(observations).toEqual([
      expect.objectContaining({ file: "src/a.ts", line: 0, functionName: "alpha" }),
    ]);
  });

  it("detects and reads runtime files by content", () => {
    const dir = tempDir();
    const lcov = join(dir, "cov.lcov");
    const otel = join(dir, "spans.json");
    writeFileSync(lcov, "SF:src/a.ts\nDA:1,1\nend_of_record\n");
    writeFileSync(otel, '{"spans":[]}');
    expect(readRuntimeFile(lcov).format).toBe("lcov");
    expect(readRuntimeFile(otel).format).toBe("otel");
    expect(readRuntimeFile(otel).content).toBe('{"spans":[]}');
  });
});

describe("runtime evidence application", () => {
  let fixture: { root: string; cleanup: () => void };
  let dbDir: string;
  let graph: OpenGraph;
  let repoId: string;

  beforeEach(() => {
    fixture = copyFixture();
    dbDir = tempDir();
    graph = openGraph(join(dbDir, "graph.db"));
    repoId = repositoryIdFor(fixture.root);
  });

  afterEach(async () => {
    graph.close();
    fixture.cleanup();
    await cleanup([dbDir]);
  });

  it("upgrades a TESTS edge and preserves it across re-indexing", () => {
    graph.indexer.index(fixture.root);
    const before = graph.repository.getEdges({
      repositoryId: repoId,
      edgeTypes: ["TESTS"],
      limit: 500,
    });
    const target = before.find(
      (edge) => edge.evidence.file === "tests/user.service.test.ts" && edge.evidence.line != null,
    );
    expect(target).toBeDefined();
    const line = target!.evidence.line!;

    const report = applyRuntimeEvidence(
      graph.repository,
      repoId,
      parseLcov(`SF:tests/user.service.test.ts\nDA:${line},1\nend_of_record\n`),
      fixture.root,
    );
    expect(report.upgraded).toBeGreaterThanOrEqual(1);

    const upgraded = graph.repository.getEdges({
      repositoryId: repoId,
      edgeTypes: ["TESTS"],
      limit: 500,
    });
    const observed = upgraded.find((edge) => edge.id === target!.id)!;
    expect(observed.evidence.source).toBe("runtime");
    expect(observed.confidence).toBeCloseTo(0.9);

    graph.indexer.index(fixture.root);
    const after = graph.repository
      .getEdges({ repositoryId: repoId, edgeTypes: ["TESTS"], limit: 500 })
      .find((edge) => edge.id === target!.id)!;
    expect(after.evidence.source).toBe("runtime");
  });

  it("ingests lcov through the shared entry point", () => {
    graph.indexer.index(fixture.root);
    const target = graph.repository
      .getEdges({ repositoryId: repoId, edgeTypes: ["TESTS"], limit: 500 })
      .find((edge) => edge.evidence.file === "tests/user.service.test.ts" && edge.evidence.line);
    expect(target).toBeDefined();
    const report = ingestRuntime(
      graph.repository,
      repoId,
      "lcov",
      `SF:tests/user.service.test.ts\nDA:${target!.evidence.line},1\nend_of_record\n`,
      fixture.root,
    );
    expect(report.observations).toBeGreaterThanOrEqual(1);
    expect(report.upgraded).toBeGreaterThanOrEqual(1);
  });

  it("reports a static conflict instead of deleting the edge", () => {
    graph.indexer.index(fixture.root);
    const before = graph.repository.getEdges({
      repositoryId: repoId,
      edgeTypes: ["TESTS"],
      limit: 500,
    });
    const target = before.find(
      (edge) => edge.evidence.file === "tests/user.service.test.ts" && edge.evidence.line != null,
    )!;

    const report = applyRuntimeEvidence(
      graph.repository,
      repoId,
      parseLcov(`SF:tests/user.service.test.ts\nDA:${target.evidence.line},0\nend_of_record\n`),
      fixture.root,
    );
    expect(report.conflicts).toBeGreaterThanOrEqual(1);
    expect(report.diagnostics[0]?.kind).toBe("runtime-conflict");

    const after = graph.repository
      .getEdges({ repositoryId: repoId, edgeTypes: ["TESTS"], limit: 500 })
      .find((edge) => edge.id === target.id)!;
    expect(after.evidence.source).toBe("static");
  });
});
