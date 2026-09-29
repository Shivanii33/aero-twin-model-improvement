import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const key = process.env.AEROTWIN_LINK_KEY || randomBytes(32).toString("hex");
const port = process.env.API_PORT || "3101";
const env = { ...process.env, AEROTWIN_LINK_KEY: key, API_PORT: port, AEROTWIN_GROUND_URL: process.env.AEROTWIN_GROUND_URL || `http://127.0.0.1:${port}` };
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    } else child.kill("SIGTERM");
  }
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
for (const name of ["dev:server", "dev:onboard", "dev:client"]) {
  const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [name], { stdio: "inherit", env, detached: process.platform !== "win32" });
  children.push(child);
  child.on("exit", code => { if (!stopping) stop(code || 1); });
}
console.log("AeroTwin split mode: onboard -> signed local link -> ground + dashboard. Edge mode displays received telemetry.");
