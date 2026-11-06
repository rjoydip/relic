import { type Context } from "hono";
import { type UserUpdate, userService } from "../services/user";

export class UserController {
  async updateUser(c: Context): Promise<Response> {
    const id = c.req.param("id") ?? "";
    const data: UserUpdate = await c.req.json<UserUpdate>();
    await userService.updateUser(id, data);
    return c.json({ ok: true });
  }
}

export const userController = new UserController();
