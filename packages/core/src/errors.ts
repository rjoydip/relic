export type GraphErrorCode =
  | "REPOSITORY_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "INVALID_INPUT"
  | "PATH_ESCAPE"
  | "INDEXING_FAILED";

export class GraphError extends Error {
  constructor(
    public readonly code: GraphErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}
