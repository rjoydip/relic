import { sha1 } from "./discovery";

/** Stable node identity. See PLAN.md §5.1: identity derives from repository,
 * path, qualified name — not line numbers (they change on edit).
 * ponytail: symbol kind is not part of the id, so overloaded functions
 * collapse into one node; add kind to the key when overload reporting matters. */
export const repositoryNodeId = (repositoryId: string): string =>
  sha1(`${repositoryId}:repository`);
export const fileId = (repositoryId: string, filePath: string): string =>
  sha1(`${repositoryId}:file:${filePath}`);
export const symbolId = (repositoryId: string, filePath: string, qualifiedName: string): string =>
  sha1(`${repositoryId}:symbol:${filePath}:${qualifiedName}`);
export const testNodeId = (repositoryId: string, filePath: string): string =>
  sha1(`${repositoryId}:test:${filePath}`);
/** Routes are identified repo-wide so frontend operations can reference them. */
export const routeId = (repositoryId: string, method: string, path: string): string =>
  sha1(`${repositoryId}:route:${method} ${path}`);
export const apiOperationId = (repositoryId: string, qualifiedName: string): string =>
  sha1(`${repositoryId}:api_operation:${qualifiedName}`);
export const frontendOperationId = (repositoryId: string, name: string): string =>
  sha1(`${repositoryId}:frontend_operation:${name}`);
export const queueId = (repositoryId: string, name: string): string =>
  sha1(`${repositoryId}:queue:${name}`);
export const databaseTableId = (repositoryId: string, table: string): string =>
  sha1(`${repositoryId}:table:${table}`);
export const edgeId = (sourceId: string, targetId: string, type: string): string =>
  sha1(`${sourceId}|${targetId}|${type}`);
