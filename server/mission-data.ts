import type { DatabaseSync } from "node:sqlite";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { TelemetryPayload } from "./telemetry-pipeline";

export type StoredSample = { id: number; ts: string; payload: string; equivalent_hours?: number };
export type StoredMission = { id: string; mission: string; status: string; created_at: string; report_notes: string };
const LEGACY_ID = "UNASSIGNED";

export function ensureMissionTelemetrySchema(db: DatabaseSync) {
  const columns = db.prepare("PRAGMA table_info(telemetry_history)").all() as { name: string }[];
  if (!columns.some(column => column.name === "mission_id")) db.exec("ALTER TABLE telemetry_history ADD COLUMN mission_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS telemetry_history_mission_id ON telemetry_history(mission_id, id)");
}

export function listReplayRuns(db: DatabaseSync) {
  const missions = db.prepare(`SELECT m.id, m.mission, m.status, m.created_at, m.report_notes,
    CASE WHEN lower(m.mission) = 'endurance mission' THEN (SELECT COUNT(*) FROM endurance_samples s WHERE s.run_id = m.id)
    ELSE (SELECT COUNT(*) FROM telemetry_history t WHERE t.mission_id = m.id) END AS sample_count
    FROM missions m WHERE sample_count > 0 ORDER BY m.created_at DESC LIMIT 30`).all();
  const legacy = db.prepare("SELECT COUNT(*) AS count, MIN(ts) AS first_ts FROM telemetry_history WHERE mission_id IS NULL").get() as { count: number; first_ts: string | null };
  return [...missions, ...(legacy.count ? [{ id: LEGACY_ID, mission: "Unassigned telemetry (legacy)", status: "RECORDED", created_at: legacy.first_ts, report_notes: "Stored before mission attribution was enabled", sample_count: legacy.count }] : [])];
}

export function readMissionSamples(db: DatabaseSync, id: string, limit = 600): StoredSample[] | null {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) return null;
  if (id === LEGACY_ID) return (db.prepare("SELECT id, ts, payload FROM (SELECT id, ts, payload FROM telemetry_history WHERE mission_id IS NULL ORDER BY id DESC LIMIT ?) ORDER BY id ASC").all(limit) as StoredSample[]);
  const mission = db.prepare("SELECT mission FROM missions WHERE id = ?").get(id) as { mission: string } | undefined;
  if (!mission) return null;
  if (mission.mission.toLowerCase() === "endurance mission") return db.prepare("SELECT id, ts, equivalent_hours, payload FROM (SELECT id, ts, equivalent_hours, payload FROM endurance_samples WHERE run_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC").all(id, limit) as StoredSample[];
  return db.prepare("SELECT id, ts, payload FROM (SELECT id, ts, payload FROM telemetry_history WHERE mission_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC").all(id, limit) as StoredSample[];
}

export function estimatedEfficiency(sample: Pick<TelemetryPayload, "fuelFlow" | "rpm" | "map">) {
  // Engineering estimate only: fuel density 0.74 kg/L; 30 kW reference shaft power at 6000 RPM and 1 bar MAP.
  const powerKw = 30 * Math.max(sample.rpm, 0) / 6000 * Math.max(sample.map, 0);
  return { powerKw: Number(powerKw.toFixed(2)), sfc: powerKw > 0 ? Number((sample.fuelFlow * 740 / powerKw).toFixed(1)) : null };
}

export function serializeReplaySamples(rows: StoredSample[]) {
  return rows.flatMap(row => {
    try {
      const payload = JSON.parse(row.payload) as TelemetryPayload;
      const actual = payload.egt?.[2];
      const baseline = payload.physics?.expected?.egt?.[2];
      if (!Number.isFinite(actual) || !Number.isFinite(baseline)) return [];
      return [{ id: row.id, ts: row.ts, equivalentHours: row.equivalent_hours ?? null,
        actual, baseline, residual: Number((actual - baseline).toFixed(1)), health: payload.health,
        rul: payload.rul, rpm: payload.rpm, map: payload.map, fuelFlow: payload.fuelFlow,
        faults: payload.faults ?? [], advisories: payload.advisories ?? [], ...estimatedEfficiency(payload) }];
    } catch { return []; }
  });
}

export async function createMissionReport(db: DatabaseSync, id: string): Promise<Uint8Array | null> {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) return null;
  const mission = db.prepare("SELECT id, mission, status, created_at, report_notes FROM missions WHERE id = ?").get(id) as StoredMission | undefined;
  if (!mission && id !== LEGACY_ID) return null;
  const samples = serializeReplaySamples(readMissionSamples(db, id, 600) ?? []);
  if (!samples.length) return null;
  const faults = db.prepare("SELECT type, severity, confidence, detail, ts FROM faults WHERE mission_id = ? ORDER BY id DESC LIMIT 20").all(id) as { type: string; severity: string; confidence: number; detail: string; ts: string }[];
  const latest = samples[samples.length - 1];
  const advisories = latest.advisories;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let y = 798;
  const clean = (value: unknown) => String(value ?? "").normalize("NFKD").replace(/[^\x20-\x7E]/g, "-");
  const line = (text: string, size = 10, heading = false) => {
    if (y < 62) { page = pdf.addPage([595, 842]); y = 798; }
    const safe = clean(text);
    const width = 100;
    for (let i = 0; i < safe.length; i += width) {
      page.drawText(safe.slice(i, i + width), { x: 42, y, size, font: heading ? bold : font, color: heading ? rgb(.13, .35, .28) : rgb(.14, .2, .2) });
      y -= size + 6;
    }
  };
  line("AEROTWIN / MISSION HEALTH REPORT", 18, true);
  line(`Mission: ${mission?.mission ?? "Unassigned legacy telemetry"} (${id})`, 12, true);
  line(`Status: ${mission?.status ?? "RECORDED"} | Recorded: ${mission?.created_at ?? samples[0].ts}`);
  line(`Generated: ${new Date().toISOString()} | ${samples.length} stored samples in report window`);
  y -= 12;
  line("HEALTH AND PROGNOSTICS", 12, true);
  line(`Health index: ${latest.health ?? "Unavailable"} / 100`);
  line(`Remaining useful life (model estimate): ${latest.rul ?? "Unavailable"} hours`);
  line(`Fuel flow: ${latest.fuelFlow} L/h | Estimated power: ${latest.powerKw} kW | Estimated SFC: ${latest.sfc ?? "Unavailable"} g/kWh`);
  line("SFC uses assumed 0.74 kg/L fuel density and 30 kW at 6000 RPM / 1 bar MAP; not measured shaft power.");
  y -= 12;
  line("PERSISTED FAULTS", 12, true);
  if (!faults.length) line("No faults recorded for this mission.");
  faults.forEach(fault => line(`${fault.ts} | ${fault.severity} ${fault.type} (${Math.round(fault.confidence * 100)}%) - ${fault.detail}`));
  y -= 12;
  line("RECOMMENDATIONS", 12, true);
  if (!advisories.length && !faults.length) line("Continue monitoring; review the next mission trace for changes.");
  if (!advisories.length && faults.length) line("Inspect and validate the listed fault channels before the next sortie; prioritize HIGH severity events.");
  advisories.forEach(advisory => line(`${advisory.urgency} / ${advisory.component}: ${advisory.action} (within ${advisory.hoursToAction} hours)`));
  if (mission?.report_notes) { y -= 12; line("MISSION NOTES", 12, true); line(mission.report_notes); }
  return pdf.save();
}

export const DEFAULT_REPLAY_MISSION = "UNASSIGNED";
