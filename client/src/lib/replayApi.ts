import type { FlightLog, ReplayPoint } from "./flightLogStore";

type RunRow = { id: string; mission: string; created_at: string; report_notes: string; sample_count: number };
type Sample = Omit<ReplayPoint, "time" | "label"> & { id: number; equivalentHours: number | null; map: number };
export async function fetchReplayRuns(): Promise<FlightLog[]> {
  const response = await fetch("/api/replay/runs");
  if (!response.ok) throw new Error("Replay runs unavailable");
  const rows = await response.json() as RunRow[];
  return Promise.all(rows.slice(0, 12).map(async row => {
    const result = await fetch(`/api/replay/runs/${encodeURIComponent(row.id)}`);
    if (!result.ok) throw new Error(`Replay ${row.id} unavailable`);
    const { samples } = await result.json() as { samples: Sample[] };
    const first = Date.parse(samples[0]?.ts ?? row.created_at);
    const points = samples.map((sample, index) => {
      const seconds = Math.max(0, (Date.parse(sample.ts) - first) / 1000);
      return { ...sample, time: seconds, label: sample.equivalentHours !== null ? `${sample.equivalentHours.toFixed(1)}h` : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`, ts: sample.ts };
    });
    const durationSeconds = points.at(-1)?.time ?? 0;
    return { id: row.id, mission: row.mission, date: new Date(row.created_at).toLocaleDateString(),
      duration: `${Math.floor(durationSeconds / 60)}:${String(Math.floor(durationSeconds % 60)).padStart(2, "0")}`,
      aircraft: "AP-04 / simulated", data: points, attention: [], sampleCount: row.sample_count, reportNotes: row.report_notes };
  }));
}
