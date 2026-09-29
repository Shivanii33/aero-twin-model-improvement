#!/usr/bin/env node
// Runs the Vite frontend and the Express + SQLite API server together for
// `npm run dev`, so live telemetry actually reaches the browser during
// development instead of quietly falling back to static placeholder values.
//
// Deliberately dependency-free (no `concurrently`) so it works offline and
// on any machine that already has the project's existing devDependencies.

import { spawn } from "node:child_process";
import process from "node:process";

const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";

const API_PORT = process.env.API_PORT || "3001";

const children = [];
let shuttingDown = false;

function launch(name, args, extraEnv = {}) {
  const child = spawn(npmCmd, args, {
    stdio: "inherit",
    shell: isWindows,
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.log(`[dev] "${name}" exited with code ${code}. Stopping the other process...`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`[dev] Starting API server on port ${API_PORT} and Vite frontend...`);
launch("api", ["run", "dev:server"], { API_PORT, PORT: API_PORT });
launch("client", ["run", "dev:client"], { API_PORT });
