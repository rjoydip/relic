import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  extractFile,
  makeRepositoryContext,
  relate,
  walkRepository,
  type RefInfo,
  type RefLookup,
} from "@relic/analyzer-typescript";
import { FIXTURE_ROOT } from "../../helpers";

const repo = makeRepositoryContext(join(FIXTURE_ROOT, "..", "frameworks"));

function lookupFrom(all: RefInfo[]): RefLookup {
  return {
    findByName: (name) =>
      all.filter(
        (r) => r.name === name || r.qualifiedName === name || r.qualifiedName.endsWith(`.${name}`),
      ),
  };
}

const files = walkRepository(repo.rootPath).map((path) => extractFile(repo, path));
const lookup = lookupFrom(files.flatMap((file) => file.refs));
const routes = files.flatMap((file) => file.nodes).filter((node) => node.type === "route");

describe("framework route discovery", () => {
  it("finds Next.js App and Pages routes", () => {
    const names = routes.map((route) => route.qualifiedName);
    expect(names).toContain("GET /users/:id");
    expect(names).toContain("POST /users/:id");
    expect(names).toContain("ANY /api/health");
    expect(names).toContain("GET /profile/:id");
  });

  it("finds NestJS controller routes", () => {
    const names = routes.map((route) => route.qualifiedName);
    expect(names).toContain("GET /users");
    expect(names).toContain("GET /users/:id");
    expect(names).toContain("POST /users");
  });

  it("finds Express and tRPC routes", () => {
    const names = routes.map((route) => route.qualifiedName);
    expect(names).toContain("GET /express/ping");
    expect(names).toContain("POST /express/users");
    expect(names).toContain("QUERY /trpc/getUser");
    expect(names).toContain("MUTATION /trpc/updateUser");
  });

  it("exposes a resolvable handler for every discovered route", () => {
    const exposes = files
      .flatMap((file) => relate(repo, file, lookup).edges)
      .filter((edge) => edge.type === "EXPOSES");
    const sources = new Set(exposes.map((edge) => edge.sourceId));
    for (const route of routes) {
      expect(sources.has(route.id)).toBe(true);
    }
  });
});
