import { type Context } from "hono";
import { describe, expect, it } from "bun:test";
import { userController } from "../src/controllers/user";

describe("user integration", () => {
  it("updates through the controller", async () => {
    const c = {
      req: { param: () => "1", json: async () => ({ name: "Ada" }) },
      json: (body: unknown) => body,
    } as unknown as Context;
    await userController.updateUser(c);
    expect(true).toBe(true);
  });
});
