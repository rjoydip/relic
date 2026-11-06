// @ts-nocheck
import express from "express";

const app = express();

function ping(_req: unknown, res: { json: (value: unknown) => void }) {
  res.json({ ok: true });
}

function createUser(
  _req: unknown,
  res: { status: (code: number) => { json: (v: unknown) => void } },
) {
  res.status(201).json({});
}

app.get("/express/ping", ping);
app.post("/express/users", createUser);

export { app };
