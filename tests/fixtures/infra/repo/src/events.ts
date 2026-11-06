import { bus } from "./bus";

export function publishUserCreated(id: string): void {
  bus.publish("user.created", { id });
}

export function subscribeUserDeleted(): void {
  bus.subscribe("user.deleted", (_payload: unknown) => {});
}
