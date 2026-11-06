export const bus = {
  publish: (_topic: string, _payload: unknown): void => {},
  subscribe: (_topic: string, _handler: (payload: unknown) => void): void => {},
};
