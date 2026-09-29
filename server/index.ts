import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initializeModel, getModelMetrics } from "./model";
import { createEngineSimulator, createEnduranceEngineSimulator, enduranceHours } from "./engine-simulator";
import { createTelemetryPipeline, createGroundPipeline, TICK_INTERVAL_MS, type TelemetryPayload, type TelemetryPipeline } from "./telemetry-pipeline";
import { ensureLinkSchema, linkKey, verifyEnvelope } from "./link-security";
import { apiAuth, authRequired, createSession, currentRole, validateAuthConfig } from "./api-auth";
import type { TelemetryControls } from "./telemetry-controls";
import type { FaultEvent } from "../shared/telemetry";
import { FRAME_SPECS } from "./can-fd";
import { parseControls } from "./telemetry-controls";
import { scoreLandingZones } from "./population-grid";
import { createMissionReport, ensureMissionTelemetrySchema, listReplayRuns, readMissionSamples, serializeReplaySamples } from "./mission-data";
import { SCENARIOS, scenarioControls, type ScenarioId } from "./scenarios";

const DEFAULT_MISSION_ID = "RPL-042";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = process.env.AEROTWIN_DB_PATH || path.resolve(process.cwd(), "aerotwin.sqlite");
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS telemetry_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, mission TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, landing_mode TEXT NOT NULL, report_notes TEXT DEFAULT '');
  CREATE TABLE IF NOT EXISTS faults (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL, confidence REAL NOT NULL, detail TEXT NOT NULL, ts TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS endurance_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES missions(id), ts TEXT NOT NULL, equivalent_hours REAL NOT NULL, payload TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS endurance_samples_run_id ON endurance_samples(run_id, id);
`);
ensureMissionTelemetrySchema(db);
ensureLinkSchema(db);
const edgeGround = new Map<string, ReturnType<typeof createGroundPipeline>>();
let latestEdge: TelemetryPayload | null = null;
let latestEdgeAt = 0;
db.prepare("INSERT OR IGNORE INTO missions (id, mission, status, created_at, landing_mode, report_notes) VALUES (?, ?, ?, ?, ?, ?)").run(DEFAULT_MISSION_ID, "Live simulator telemetry", "ACTIVE", new Date().toISOString(), "NOMINAL", "Continuous simulated telemetry");
db.prepare("UPDATE missions SET status = 'INTERRUPTED' WHERE mission = 'Endurance mission' AND status = 'ACTIVE'").run();

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const validMissionId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(id);
const engine = createEngineSimulator();
const sharedPipeline = createTelemetryPipeline(engine);
type EnduranceRun = { id: string; startedAtMs: number; controls: TelemetryControls; hours: number; pipeline: TelemetryPipeline };
const enduranceRuns = new Map<string, EnduranceRun>();

// A fault is written when it becomes active, and again every FAULT_REPERSIST_MS
// while it stays active, so a sustained fault isn't logged 6–7 times a second.
const FAULT_REPERSIST_MS = 60_000;
const lastFaultWrite = new Map<string, number>();
function persistFaults(missionId: string, faults: FaultEvent[], nowMs = Date.now()) {
  const insert = db.prepare("INSERT INTO faults (mission_id, type, severity, confidence, detail, ts) VALUES (?, ?, ?, ?, ?, ?)");
  for (const f of faults) {
    const key = `${missionId}:${f.type}`;
    const last = lastFaultWrite.get(key);
    if (last !== undefined && nowMs - last < FAULT_REPERSIST_MS) continue;
    lastFaultWrite.set(key, nowMs);
    insert.run(missionId, f.type, f.severity, f.confidence, f.detail, new Date(nowMs).toISOString());
  }
}
const missionIdFrom = (query: Record<string, unknown>) => {
  const id = query.missionId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : DEFAULT_MISSION_ID;
};
function persistTelemetry(payload: TelemetryPayload, missionId: string) {
  const { faultCandidates: _candidates, can: { lastFrames: _frames, ...can }, ...rest } = payload;
  db.prepare("INSERT INTO telemetry_history (ts, payload, mission_id) VALUES (?, ?, ?)").run(payload.ts, JSON.stringify({ ...rest, can }), missionId);
}

async function startServer() {
  validateAuthConfig();
  if (process.env.NODE_ENV === "production") linkKey();
  initializeModel();
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=63072000");
    next();
  });
  const server = createServer(app);
  app.post("/internal/telemetry", express.text({ type: "application/json", limit: "32kb" }), (req, res) => {
    try {
      if (typeof req.body !== "string") return res.status(400).json({ error: "JSON body required" });
      const { source, payload } = verifyEnvelope(req.body, req.get("X-Telemetry-Signature"), linkKey(), db);
      if (!edgeGround.has(source)) edgeGround.set(source, createGroundPipeline());
      latestEdge = edgeGround.get(source)!.process(payload, true);
      latestEdgeAt = Date.now();
      persistTelemetry(latestEdge, DEFAULT_MISSION_ID);
      persistFaults(DEFAULT_MISSION_ID, latestEdge.faults);
      res.status(202).json({ accepted: true });
    } catch (error) {
      res.status(401).json({ error: error instanceof Error ? error.message : "Invalid telemetry" });
    }
  });
  app.use(express.json({ limit: "32kb" }));
  const staticPath = process.env.NODE_ENV === "production" ? path.resolve(__dirname, "public") : path.resolve(__dirname, "..", "dist", "public");

  app.get("/api/health", (_req, res) => res.json({ ok: true, database: "sqlite" }));
  app.get("/api/auth/status", (req, res) => res.set("Cache-Control", "no-store").json({ required: authRequired(), role: currentRole(req) }));
  app.post("/api/auth/session", createSession);
  app.post("/api/auth/logout", (_req, res) => res.clearCookie("aerotwin_session", { path: "/api" }).json({ ok: true }));
  app.use("/api", apiAuth);
  app.get("/api/landing-zones", (_req, res) => {
    res.set("Cache-Control", "no-store").json(scoreLandingZones(12.9716, 77.5946, 5_000));
  });
  app.get("/api/model/metrics", (_req, res) => res.set("Cache-Control", "no-store").json(getModelMetrics()));
  app.get("/api/endurance/runs", (_req, res) => res.set("Cache-Control", "no-store").json(db.prepare("SELECT id, mission, status, created_at, report_notes FROM missions WHERE mission = 'Endurance mission' ORDER BY created_at DESC LIMIT 8").all()));
  app.post("/api/endurance/runs", (req, res) => {
    try {
      const input = req.body || {};
      if (typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid flight controls.");
      const controls = parseControls(Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === "number" && Number.isFinite(value) ? String(value) : value])));
      const id = `END-${randomUUID()}`;
      const startedAtMs = Date.now();
      const run = { id, startedAtMs, controls: { ...controls, cylinderBias: 0 }, hours: 0 } as EnduranceRun;
      run.pipeline = createTelemetryPipeline(createEnduranceEngineSimulator(() => run.hours));
      db.prepare("INSERT INTO missions (id, mission, status, created_at, landing_mode, report_notes) VALUES (?, ?, ?, ?, ?, ?)").run(id, "Endurance mission", "ACTIVE", new Date(startedAtMs).toISOString(), "NOMINAL", "Accelerated time-based wear; cylinder bias isolated from mission");
      enduranceRuns.set(id, run);
      res.status(201).set("Cache-Control", "no-store").json({ id });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid flight controls" }); }
  });
  app.post("/api/endurance/runs/:id/stop", (req, res) => {
    const run = enduranceRuns.get(req.params.id);
    if (!run) return res.status(404).json({ error: "Active endurance run not found" });
    const hours = enduranceHours(run.startedAtMs, Date.now());
    db.prepare("UPDATE missions SET status = 'COMPLETED', report_notes = ? WHERE id = ?").run(`Accelerated time-based wear; ${hours.toFixed(2)} equivalent flight hours`, run.id);
    enduranceRuns.delete(run.id);
    res.json({ id: run.id, equivalentHours: hours });
  });
  app.get("/api/endurance/runs/:id/samples", (req, res) => {
    if (!/^END-[0-9a-f-]{36}$/.test(req.params.id)) return res.status(400).json({ error: "Invalid run id" });
    res.set("Cache-Control", "no-store").json(db.prepare("SELECT ts, equivalent_hours, payload FROM endurance_samples WHERE run_id = ? ORDER BY id DESC LIMIT 300").all(req.params.id));
  });
  app.use(["/api/telemetry", "/api/telemetry/stream"], (req, res, next) => {
    try { res.locals.controls = parseControls(req.query); next(); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid telemetry controls" }); }
  });
  app.get("/api/telemetry", (req, res) => {
    if (req.query.edgeMode === "true") {
      if (!latestEdge || Date.now() - latestEdgeAt > 5000) return res.status(503).json({ error: "Onboard telemetry unavailable or stale" });
      return res.set("Cache-Control", "no-store").json(latestEdge);
    }
    const payload = sharedPipeline.next(res.locals.controls);
    persistTelemetry(payload, missionIdFrom(req.query));
    persistFaults(missionIdFrom(req.query), payload.faults);
    res.set("Cache-Control", "no-store").json(payload);
  });
  app.get("/api/telemetry/stream", (req, res) => {
    const runId = req.query.enduranceId;
    const run = typeof runId === "string" ? enduranceRuns.get(runId) : undefined;
    if (runId !== undefined && !run) return res.status(404).json({ error: "Active endurance run not found" });
    if (req.query.edgeMode === "true" && run) return res.status(400).json({ error: "Edge mode is not available for endurance runs" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const pipeline = run?.pipeline ?? createTelemetryPipeline(engine);
    const missionId = run?.id ?? missionIdFrom(req.query);
    const edgeMode = req.query.edgeMode === "true";
    let lastEdgeAt = 0;
    const send = () => {
      if (run && !enduranceRuns.has(run.id)) { res.end(); return; }
      if (edgeMode) {
        if (latestEdge && latestEdgeAt !== lastEdgeAt && Date.now() - latestEdgeAt <= 5000) {
          lastEdgeAt = latestEdgeAt;
          res.write(`data: ${JSON.stringify(latestEdge)}\n\n`);
        }
        return;
      }
      try {
        const nowMs = Date.now();
        if (run) run.hours = enduranceHours(run.startedAtMs, nowMs);
        const payload = pipeline.next(run?.controls ?? res.locals.controls, nowMs, edgeMode);
        if (run) {
          const endurance = { id: run.id, equivalentHours: Number(run.hours.toFixed(2)) };
          const { can: { lastFrames: _frames, ...can }, faultCandidates: _candidates, ...rest } = payload;
          db.prepare("INSERT INTO endurance_samples (run_id, ts, equivalent_hours, payload) VALUES (?, ?, ?, ?)").run(run.id, payload.ts, run.hours, JSON.stringify({ ...rest, can, endurance }));
          persistFaults(run.id, payload.faults, nowMs);
          res.write(`data: ${JSON.stringify({ ...payload, endurance })}\n\n`);
  } else {
  persistTelemetry(payload, missionId);
  persistFaults(missionId, payload.faults, nowMs);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      } catch (error) {
        console.error("Telemetry tick failed:", error);
      }
    };
    send(); const timer = setInterval(send, TICK_INTERVAL_MS); req.on("close", () => clearInterval(timer));
  });
  app.get("/api/replay/runs", (_req, res) => res.set("Cache-Control", "no-store").json(listReplayRuns(db)));
  app.get("/api/replay/runs/:id", (req, res) => {
    const rows = readMissionSamples(db, req.params.id);
    if (!rows) return res.status(404).json({ error: "Mission not found" });
    res.set("Cache-Control", "no-store").json({ id: req.params.id, samples: serializeReplaySamples(rows) });
  });
  app.post("/api/scenarios/:id", (req, res) => {
    if (!Object.hasOwn(SCENARIOS, req.params.id)) return res.status(404).json({ error: "Unknown scenario" });
    const scenarioId = req.params.id as ScenarioId;
    const scenario = SCENARIOS[scenarioId];
    const id = `SCN-${randomUUID()}`;
    const started = Date.now();
    const pipeline = createTelemetryPipeline(scenarioId === "endurance-mission"
      ? createEnduranceEngineSimulator(() => currentHours) : createEngineSimulator());
    let currentHours = 0;
    const steps = 36;
    const samples = [];
    db.prepare("INSERT INTO missions (id, mission, status, created_at, landing_mode, report_notes) VALUES (?, ?, ?, ?, ?, ?)").run(id, scenario.name, "ACTIVE", new Date(started).toISOString(), "NOMINAL", "Scripted simulated scenario; accelerated profile, not a flown mission");
    try {
      for (let step = 0; step < steps; step++) {
        const controls = scenarioControls(scenarioId, step, steps - 1);
        currentHours = scenarioId === "endurance-mission" ? step * 24 / (steps - 1) : 0;
        const payload = pipeline.next(controls, started + step * TICK_INTERVAL_MS);
        if (scenarioId === "endurance-mission") {
          const { can: { lastFrames: _frames, ...can }, faultCandidates: _candidates, ...rest } = payload;
          db.prepare("INSERT INTO endurance_samples (run_id, ts, equivalent_hours, payload) VALUES (?, ?, ?, ?)").run(id, payload.ts, currentHours, JSON.stringify({ ...rest, can }));
        } else persistTelemetry(payload, id);
        persistFaults(id, payload.faults, started + step * TICK_INTERVAL_MS);
        samples.push(payload);
      }
      db.prepare("UPDATE missions SET status = 'COMPLETED' WHERE id = ?").run(id);
      res.status(201).set("Cache-Control", "no-store").json({ id, name: scenario.name, controls: scenarioControls(scenarioId, steps - 1, steps - 1), sampleCount: samples.length });
    } catch (error) {
      db.prepare("UPDATE missions SET status = 'INTERRUPTED' WHERE id = ?").run(id);
      res.status(500).json({ error: "Scenario simulation failed" });
    }
  });
  app.get("/api/telemetry/history", (req, res) => { const limit = clamp(Number(req.query.limit || 100), 1, 1000); res.json(db.prepare("SELECT id, ts, payload FROM telemetry_history ORDER BY id DESC LIMIT ?").all(limit)); });
  app.post("/api/missions", (req, res) => {
    const body = req.body || {};
    const id = body.id || `MSN-${Date.now()}`;
    if (!validMissionId(id) || [body.mission, body.status, body.landingMode, body.reportNotes].some(v => v !== undefined && (typeof v !== "string" || v.length > 500))) return res.status(400).json({ error: "Invalid mission fields" });
    db.prepare("INSERT OR REPLACE INTO missions (id, mission, status, created_at, landing_mode, report_notes) VALUES (?, ?, ?, ?, ?, ?)").run(id, body.mission || "TAPAS patrol", body.status || "ACTIVE", new Date().toISOString(), body.landingMode || "NOMINAL", body.reportNotes || "");
    res.status(201).json({ id });
  });
  app.get("/api/missions", (_req, res) => res.json(db.prepare("SELECT * FROM missions ORDER BY created_at DESC").all()));
  app.patch("/api/missions/:id/decision", (req, res) => {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(req.params.id)) return res.status(400).json({ error: "Invalid mission id" });
    if (!(["RTB", "EMERGENCY LANDING"] as unknown[]).includes(req.body?.status) || typeof req.body?.landingMode !== "string" || req.body.landingMode.length > 120) return res.status(400).json({ error: "Invalid decision" });
    const updated = db.prepare("UPDATE missions SET status = ?, landing_mode = ? WHERE id = ?").run(req.body.status, req.body.landingMode, req.params.id);
    if (!updated.changes) return res.status(404).json({ error: "Mission not found" });
    res.json({ id: req.params.id });
  });
  app.post("/api/faults", (req, res) => {
    const b = req.body || {};
    if (!validMissionId(b.missionId || DEFAULT_MISSION_ID) ||
        [b.type, b.detail].some(v => v !== undefined && (typeof v !== "string" || v.length > 500)) ||
        (b.severity !== undefined && !["LOW", "MEDIUM", "HIGH"].includes(b.severity)) ||
        (b.confidence !== undefined && (typeof b.confidence !== "number" || !Number.isFinite(b.confidence) || b.confidence < 0 || b.confidence > 1))) return res.status(400).json({ error: "Invalid fault fields" });
    db.prepare("INSERT INTO faults (mission_id, type, severity, confidence, detail, ts) VALUES (?, ?, ?, ?, ?, ?)").run(b.missionId || DEFAULT_MISSION_ID, b.type || "sensor drift", b.severity || "MEDIUM", b.confidence ?? .5, b.detail || "Maintenance recorded fault", new Date().toISOString());
    res.status(201).json({ ok: true });
  });
  app.get("/api/faults", (req, res) => res.json(db.prepare("SELECT * FROM faults WHERE mission_id = ? ORDER BY id DESC LIMIT 100").all(String(req.query.missionId || DEFAULT_MISSION_ID))));
  app.get("/api/can/status", (_req, res) => res.json({
    bus: "CAN-FD", bitrate: "2 Mbps", ecu: "AP04-ECU", status: "ONLINE",
    framesPerSecond: Math.round((1000 / TICK_INTERVAL_MS) * FRAME_SPECS.length),
    frames: FRAME_SPECS.map((f) => ({ id: `0x${f.id.toString(16).toUpperCase()}`, name: f.name, dlc: f.dlc, signals: f.signals.map((sig) => sig.name) })),
  }));
  app.use("/api/reports/:missionId", (req, res, next) => validMissionId(req.params.missionId) ? next() : res.status(400).json({ error: "Invalid mission id" }));
  app.get("/api/reports/:missionId", async (req, res) => {
    try {
      const pdf = await createMissionReport(db, req.params.missionId);
      if (!pdf) return res.status(404).json({ error: "Mission or stored telemetry not found" });
      res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="aerotwin-${req.params.missionId}.pdf"`, "Cache-Control": "no-store" }).send(Buffer.from(pdf));
    } catch (error) { console.error("Report generation failed:", error); res.status(500).json({ error: "Report generation failed" }); }
  });
  app.get("/api/reports/:missionId/print", (req, res) => { const mission = db.prepare("SELECT * FROM missions WHERE id = ?").get(req.params.missionId) as any; const faults = db.prepare("SELECT * FROM faults WHERE mission_id = ? ORDER BY id DESC LIMIT 20").all(req.params.missionId); const latest = db.prepare("SELECT payload FROM telemetry_history ORDER BY id DESC LIMIT 1").get() as any; const telemetry = latest ? JSON.parse(latest.payload) : sharedPipeline.next(parseControls({})); res.type("html").send(`<!doctype html><title>AeroTwin Health Report ${req.params.missionId}</title><style>body{font:14px Arial;color:#182522;max-width:900px;margin:40px auto}h1{color:#1b5144;border-bottom:3px solid #b9f49a;padding-bottom:12px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{border:1px solid #ccd9d3;border-radius:8px;padding:14px}.muted{color:#5b7169}table{width:100%;border-collapse:collapse;margin-top:20px}td,th{padding:9px;border-bottom:1px solid #dbe5df;text-align:left}@media print{button{display:none}}</style><button onclick="window.print()">Print / Save as PDF</button><h1>AeroTwin Mission Health Report — ${req.params.missionId}</h1><p class="muted">Generated ${new Date().toISOString()} · persisted SQLite telemetry history · CAN-FD gateway</p><h2>${escapeHtml(mission?.mission || "Mission health snapshot")}</h2><div class="grid">${["Fuel flow", `${telemetry.fuelFlow} L/h`, "Vibration", `${telemetry.vibration} mm/s`, "Battery / alternator", `${telemetry.batteryVoltage} V / ${telemetry.alternatorHealth}%`, "Injection timing", `${telemetry.injectionTiming}°`].map((x) => `<div class="card"><b>${escapeHtml(x)}</b></div>`).join("")}</div><h2>Detected fault types</h2><table><tr><th>Type</th><th>Severity</th><th>Confidence</th><th>Detail</th></tr>${faults.map((f: any) => `<tr><td>${escapeHtml(f.type)}</td><td>${escapeHtml(f.severity)}</td><td>${Math.round(f.confidence*100)}%</td><td>${escapeHtml(f.detail)}</td></tr>`).join("") || `<tr><td colspan="4">No persisted faults for this mission.</td></tr>`}</table><h2>Landing decision</h2><p>${mission?.landing_mode || "RTB / emergency landing logic"}: safe-radius and least-populated-area selection is shown in the mission planner.</p>`); });
  // In dev, the frontend is served by Vite (port 3000) and this server only
  // needs to answer /api/* (proxied from Vite — see vite.config.ts). In
  // production ("npm run build && npm start") this same server serves the
  // built static files too, so the static/catch-all routes stay registered
  // in both modes; they're simply unused in dev.
  app.use(express.static(staticPath));
  app.get("*", (_req, res) => res.sendFile(path.join(staticPath, "index.html")));

  const isProd = process.env.NODE_ENV === "production";
  const port = Number(process.env.PORT || process.env.API_PORT || (isProd ? 3000 : 3001));
  server.listen(port, "0.0.0.0", () =>
    console.log(`Server running on http://localhost:${port}/ with SQLite persistence${isProd ? "" : " (dev API — Vite proxies /api here)"}`)
  );
}
startServer().catch((err) => {
  console.error("Failed to start AeroTwin server:", err);
  if (String(err?.message || err).includes("sqlite")) {
    console.error(
      "node:sqlite requires Node.js 22.5+ (23.4+ recommended, no flag needed). Check `node -v` and upgrade if this is the cause."
    );
  }
  process.exit(1);
});
