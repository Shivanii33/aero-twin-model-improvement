import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

const temp = mkdtempSync(path.join(tmpdir(), "aerotwin-api-"));
let child: ChildProcess;
let base: string;
let output = "";
const port = await new Promise<number>(resolve => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close(() => resolve(port)); });
});

before(async () => {
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(), env: { ...process.env, API_PORT: String(port), AEROTWIN_DB_PATH: path.join(temp, "test.sqlite") }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", chunk => { output += chunk; });
  child.stderr?.on("data", chunk => { output += chunk; });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`API server exited: ${output}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* Starting model. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`API server not ready: ${output}`);
});
after(() => { child?.kill(); rmSync(temp, { recursive: true, force: true }); });

test("scenario API validates presets and stores replay samples isolated by mission", async () => {
  const invalid = await fetch(`${base}/api/scenarios/unknown`, { method: "POST" });
  assert.equal(invalid.status, 404);
  const high = await fetch(`${base}/api/scenarios/high-altitude`, { method: "POST" });
  assert.equal(high.status, 201);
  const result = await high.json() as { id: string; controls: { altitude: number }; sampleCount: number };
  assert.equal(result.controls.altitude, 15500);
  assert.equal(result.sampleCount, 36);
  const list = await (await fetch(`${base}/api/replay/runs`)).json() as { id: string; sample_count: number }[];
  assert.ok(list.some(row => row.id === result.id && row.sample_count === 36));
  const replay = await (await fetch(`${base}/api/replay/runs/${result.id}`)).json() as { samples: { id: number; actual: number; baseline: number; sfc: number; powerKw: number; health: number }[] };
  assert.equal(replay.samples.length, 36);
  assert.ok(replay.samples.every(sample => Number.isFinite(sample.actual) && Number.isFinite(sample.baseline) && sample.sfc > 0 && sample.powerKw > 0));
  assert.ok(replay.samples.every((sample, index) => index === 0 || sample.id > replay.samples[index - 1].id));
  assert.equal((await fetch(`${base}/api/replay/runs/not-found`)).status, 404);
  const report = await fetch(`${base}/api/reports/${result.id}`);
  assert.equal(report.status, 200);
  assert.match(report.headers.get("content-type") ?? "", /application\/pdf/);
  assert.match(report.headers.get("content-disposition") ?? "", /attachment.*\.pdf/);
  assert.equal(Buffer.from(await report.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  assert.equal((await fetch(`${base}/api/reports/not-found`)).status, 404);
});

test("endurance preset writes endurance_samples; existing endpoints remain available", async () => {
  const response = await fetch(`${base}/api/scenarios/endurance-mission`, { method: "POST" });
  assert.equal(response.status, 201);
  const result = await response.json() as { id: string };
  const replay = await (await fetch(`${base}/api/replay/runs/${result.id}`)).json() as { samples: { equivalentHours: number }[] };
  assert.equal(replay.samples.length, 36);
  assert.equal(replay.samples.at(-1)?.equivalentHours, 24);
  assert.equal((await fetch(`${base}/api/endurance/runs/${result.id}/samples`)).status, 400);
  assert.equal((await fetch(`${base}/api/telemetry/history?limit=2`)).status, 200);
  assert.equal((await fetch(`${base}/api/telemetry?rpm=invalid`)).status, 400);
  assert.equal((await fetch(`${base}/api/missions`)).status, 200);
  for (const [preset, rpm] of [["hot-weather", 6200], ["rapid-throttle", 3500]] as const) {
    const run = await fetch(`${base}/api/scenarios/${preset}`, { method: "POST" });
    assert.equal(run.status, 201);
    const { id, controls, sampleCount } = await run.json() as { id: string; controls: { rpm: number }; sampleCount: number };
    assert.equal(controls.rpm, rpm);
    assert.equal(sampleCount, 36);
    const history = await (await fetch(`${base}/api/replay/runs/${id}`)).json() as { samples: unknown[] };
    assert.equal(history.samples.length, 36);
  }
});
