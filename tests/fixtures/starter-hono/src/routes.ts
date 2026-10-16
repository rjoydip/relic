import { Hono } from "hono";
import { userController } from "./controllers/user";

const app = new Hono();

app.patch("/users/:id", userController.updateUser);
app.get("/users/:id", (c) => c.json({ ok: true }));

export { app };
