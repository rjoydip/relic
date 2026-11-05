import { spawn, spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const children = [];
let shuttingDown = false;

const services = [
  { name: "api", args: ["run", "dev:api"] },
  { name: "dashboard", args: ["run", "dev:web"] },
  { name: "docs", args: ["run", "docs:dev"] },
];

function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode !== null || child.killed) continue;
    if (isWindows) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 150);
}

for (const service of services) {
  const child = spawn("bun", service.args, { stdio: "inherit" });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${service.name} stopped (${signal ?? code ?? "unknown"})`);
    stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
