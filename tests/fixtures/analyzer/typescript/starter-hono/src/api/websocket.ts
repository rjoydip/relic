import { userService } from "../services/user";

export interface Socket {
  on(event: string, handler: (payload: { id: string }) => void): void;
}

export function attachSocket(socket: Socket): void {
  socket.on("user:update", (payload) => {
    void userService.updateUser(payload.id, {});
  });
}
