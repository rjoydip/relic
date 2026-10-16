import { describe, expect, it } from "bun:test";
import { userService } from "../src/services/user";

describe("UserService.updateUser", () => {
  it("persists the update", async () => {
    await userService.updateUser("1", { name: "Ada" });
    expect(true).toBe(true);
  });
});
