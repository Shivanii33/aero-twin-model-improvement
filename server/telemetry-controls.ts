export type TelemetryControls = { rpm: number; map: number; altitude: number; cylinderBias: number; ambientC: number };
export function parseControls(query: Record<string, unknown>): TelemetryControls {
  const limits = { rpm: [5203, 1000, 7200], map: [.84, .3, 1.84], altitude: [8200, 0, 16000], cylinderBias: [18, 0, 80], ambientC: [15, -10, 50] as const } as const;
  const result = {} as TelemetryControls;
  for (const key of Object.keys(limits) as (keyof TelemetryControls)[]) {
    const [fallback, min, max] = limits[key];
    const raw = query[key];
    if (raw !== undefined && (typeof raw !== "string" || raw.trim() === "")) throw new Error(`Invalid ${key}: expected a single number.`);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}: expected ${min}–${max}.`);
    result[key] = value;
  }
  return result;
}
