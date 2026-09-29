import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { createEngineSimulator } from "./engine-simulator";
import { createOnboardPipeline } from "./onboard-pipeline";
import { createLinkSender } from "./link-security";

const temp = mkdtempSync(path.join(tmpdir(), "aerotwin-edge-"));
const operator = "operator-token-for-test-0123456789abcdef";
const maintenance = "maintenance-token-for-test-0123456789abcdef";
const key = "link-key-for-test-0123456789abcdef1234";
let child: ChildProcess;
let base: string;
let output = "";

before(async () => {
  const port = await new Promise<number>(resolve => {
    const socket = createServer();
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(), env: {
      ...process.env, API_PORT: String(port), AEROTWIN_DB_PATH: path.join(temp, "test.sqlite"),
      AEROTWIN_OPERATOR_TOKEN: operator, AEROTWIN_MAINTENANCE_TOKEN: maintenance,
      AEROTWIN_SESSION_KEY: "session-key-for-test-0123456789abcdef", AEROTWIN_LINK_KEY: key,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", chunk => { output += chunk; });
  child.stderr?.on("data", chunk => { output += chunk; });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Ground exited: ${output}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* Model is initializing. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Ground not ready: ${output}`);
});
after(() => { child?.kill(); rmSync(temp, { recursive: true, force: true }); });

test("role tokens, sessions and signed edge telemetry enforce process boundaries", async () => {
  assert.equal((await fetch(`${base}/api/telemetry`)).status, 401);
  assert.equal((await fetch(`${base}/api/telemetry?edgeMode=true`, { headers: { Authorization: `Bearer ${operator}` } })).status, 503);
  assert.equal((await fetch(`${base}/api/scenarios/high-altitude`, { method: "POST", headers: { Authorization: `Bearer ${maintenance}` } })).status, 403);
  assert.equal((await fetch(`${base}/api/faults`, { method: "POST", headers: { Authorization: `Bearer ${operator}` } })).status, 403);
  const login = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: operator }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  assert.equal((await fetch(`${base}/api/missions`, { headers: { Cookie: cookie } })).status, 200);
  const send = createLinkSender(key, "5c7e8494-a332-41bb-8ef1-c5e1f9d44bef");
  const pipeline = createOnboardPipeline(createEngineSimulator());
  const envelope = send(pipeline.next({ rpm: 5203, map: 0.84, altitude: 8200, cylinderBias: 0, ambientC: 15 }));
  const ingest = () => fetch(`${base}/internal/telemetry`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telemetry-Signature": envelope.signature }, body: envelope.body });
  assert.equal((await ingest()).status, 202);
  assert.equal((await ingest()).status, 401);
  const edge = await fetch(`${base}/api/telemetry?edgeMode=true`, { headers: { Authorization: `Bearer ${operator}` } });
  assert.equal(edge.status, 200);
  const payload = await edge.json() as { edgeMode: boolean; model: string; can: { lastFrames: unknown[] } };
  assert.equal(payload.edgeMode, true);
  assert.ok(payload.model);
  assert.deepEqual(payload.can.lastFrames, []);
  const mission = await fetch(`${base}/api/missions`, { method: "POST", headers: { Authorization: `Bearer ${operator}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "XSS-test", mission: "<img src=x onerror=alert(1)>" }) });
  assert.equal(mission.status, 201);
  const fault = await fetch(`${base}/api/faults`, { method: "POST", headers: { Authorization: `Bearer ${maintenance}`, "Content-Type": "application/json" }, body: JSON.stringify({ missionId: "XSS-test", detail: "<script>alert(1)</script>" }) });
  assert.equal(fault.status, 201);
  const print = await (await fetch(`${base}/api/reports/XSS-test/print`, { headers: { Authorization: `Bearer ${maintenance}` } })).text();
  assert.ok(print.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(print.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!print.includes("<script>alert(1)</script>"));
});
