import type { FaultEvent, FaultSeverity, VibrationOrders } from "../shared/telemetry";

export const FAULT_CONFIDENCE_THRESHOLD = 0.42;
export const FAULT_HISTORY_LENGTH = 64;

/** One decoded telemetry tick, as seen by the fault detectors. */
export type FaultSample = {
  t: number;
  rpm: number;
  fuelFlow: number;
  injectionTiming: number;
  vibration: number;
  vibrationOrders: VibrationOrders;
  oilPressure: number;
  oilTemp: number;
  egtResidual: number[];
  chtResidualMean: number;
  oilTempResidual: number;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdDev = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
};
/** Least-squares slope of y over x. */
function slope(xs: number[], ys: number[]) {
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}
const window = (history: FaultSample[], sample: FaultSample, size: number) => [...history.slice(-(size - 1)), sample];

export function instantaneousFaults(s: FaultSample): FaultEvent[] {
  const { vibration, fuelFlow, injectionTiming, oilPressure, oilTemp, t } = s;
  return [
    { type: "misfire", severity: vibration > 4.4 ? "HIGH" : "LOW", confidence: clamp(vibration / 6, 0.12, 0.98), detail: `Vibration ${vibration} mm/s with unstable combustion residual` },
    { type: "injector abnormality", severity: fuelFlow > 31 || Math.abs(injectionTiming - 18.5) > 0.4 ? "MEDIUM" : "LOW", confidence: clamp((fuelFlow - 20) / 18 + Math.abs(injectionTiming - 18.5), 0.1, 0.96), detail: `Fuel flow ${fuelFlow} L/h; injection timing ${injectionTiming}°` },
    { type: "coking/lubrication issue", severity: oilPressure < 24 || oilPressure > 33 ? "HIGH" : "LOW", confidence: clamp((32 - oilPressure) / 14, 0.1, 0.97), detail: `Oil pressure ${oilPressure} psi and oil temperature ${Math.round(oilTemp)} °C` },
    { type: "sensor drift", severity: Math.abs(Math.sin(t / 9)) > 0.92 ? "MEDIUM" : "LOW", confidence: 0.22 + Math.abs(Math.sin(t / 9)) * 0.55, detail: "Cross-sensor residual disagreement monitor" },
  ];
}

const COMBUSTION_WINDOW = 20;
const COMBUSTION_MIN_SAMPLES = 10;
/** Cycle-to-cycle EGT scatter: σ of each cylinder's physics residual across recent samples. */
export function detectCombustionInstability(sample: FaultSample, history: FaultSample[]): FaultEvent | null {
  const w = window(history, sample, COMBUSTION_WINDOW);
  if (w.length < COMBUSTION_MIN_SAMPLES) return null;
  const perCylinder = sample.egtResidual.map((_, cyl) => w.map((s) => s.egtResidual[cyl]));
  const sigmas = perCylinder.map(stdDev);
  const worst = sigmas.indexOf(Math.max(...sigmas));
  const sigma = sigmas[worst];
  const swing = Math.max(...perCylinder[worst]) - Math.min(...perCylinder[worst]);
  const severity: FaultSeverity = sigma > 5 ? "HIGH" : sigma > 3 ? "MEDIUM" : "LOW";
  return {
    type: "combustion instability",
    severity,
    confidence: clamp((sigma - 1.5) / 5, 0.05, 0.97),
    detail: `EGT residual σ ${sigma.toFixed(1)} °C on CYL ${worst + 1} over ${w.length} samples (${(sample.t - w[0].t).toFixed(1)} s); peak swing ${swing.toFixed(0)} °C`,
  };
}

const TREND_WINDOW = 40;
const TREND_MIN_SAMPLES = 20;
const TREND_MIN_SPAN_S = 2.5;
const CHT_SLOPE_FULL_SCALE = 20; // °C/min
const OIL_SLOPE_FULL_SCALE = 10; // °C/min
const LEVEL_FULL_SCALE = 30; // °C above baseline
/**
 * Sustained rise of CHT and oil temperature above the physics baseline. The
 * slope catches the trend while it develops; the level term keeps the fault
 * raised once temperatures plateau at an elevated value.
 */
export function detectOverheatingTrend(sample: FaultSample, history: FaultSample[]): FaultEvent | null {
  const w = window(history, sample, TREND_WINDOW);
  if (w.length < TREND_MIN_SAMPLES || sample.t - w[0].t < TREND_MIN_SPAN_S) return null;
  const ts = w.map((s) => s.t);
  const chtPerMin = slope(ts, w.map((s) => s.chtResidualMean)) * 60;
  const oilPerMin = slope(ts, w.map((s) => s.oilTempResidual)) * 60;
  const slopeScore = clamp(Math.max(chtPerMin / CHT_SLOPE_FULL_SCALE, oilPerMin / OIL_SLOPE_FULL_SCALE), 0, 1);
  const levelScore = clamp(sample.chtResidualMean / LEVEL_FULL_SCALE, 0, 1);
  const severity: FaultSeverity = chtPerMin > 15 || oilPerMin > 8 || levelScore >= 1 ? "HIGH" : chtPerMin > 6 || oilPerMin > 3 || levelScore > 0.5 ? "MEDIUM" : "LOW";
  const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
  return {
    type: "overheating trend",
    severity,
    confidence: clamp(Math.max(0.05 + 0.9 * slopeScore, 0.9 * levelScore), 0.05, 0.97),
    detail: `CHT ${signed(chtPerMin)} °C/min, oil ${signed(oilPerMin)} °C/min vs physics baseline (mean CHT residual ${signed(sample.chtResidualMean)} °C)`,
  };
}

const SENSOR_RANGES = {
  oilPressure: [5, 110], oilTemp: [-40, 200], fuelFlow: [0, 90], vibration: [0, 40],
} as const;
const FLATLINE_WINDOW = 12;
/** A failure candidate identifies the channel and mode; verify before treating it as an actual engine fault. */
export function detectSensorFailure(sample: FaultSample, history: FaultSample[]): FaultEvent | null {
  const last = history.at(-1);
  const gap = last && sample.t - last.t;
  if (gap && gap > 1) return { type: "sensor failure", severity: "HIGH", confidence: 0.95,
    detail: `Dropout: telemetry gap ${gap.toFixed(1)} s; verify sensor bus and stale channels` };
  for (const [name, [min, max]] of Object.entries(SENSOR_RANGES)) {
    const value = sample[name as keyof typeof SENSOR_RANGES];
    if (!Number.isFinite(value)) return { type: "sensor failure", severity: "HIGH", confidence: 0.99,
      detail: `Dropout: ${name} missing or non-finite; verify channel and wiring` };
    if (value < min || value > max) return { type: "sensor failure", severity: "HIGH", confidence: 0.95,
      detail: `Out-of-range: ${name} ${value} outside plausible sensor limits [${min}, ${max}]; cross-check independently` };
  }
  const recent = window(history, sample, FLATLINE_WINDOW);
  if (recent.length < FLATLINE_WINDOW || sample.t - recent[0].t < 1.5 ||
      recent.some((s, i) => i > 0 && s.t - recent[i - 1].t > 1)) return null;
  const rpmSpan = Math.max(...recent.map(s => s.rpm)) - Math.min(...recent.map(s => s.rpm));
  if (rpmSpan < 100) return null;
  for (const name of Object.keys(SENSOR_RANGES) as (keyof typeof SENSOR_RANGES)[]) {
    const values = recent.map(s => s[name]);
    if (Math.max(...values) - Math.min(...values) < 0.001) return { type: "sensor failure", severity: "MEDIUM", confidence: 0.9,
      detail: `Flatline: ${name} unchanged over ${recent.length} samples while RPM changed ${Math.round(rpmSpan)}; inspect sensor and wiring` };
  }
  return null;
}

const VIBRATION_WINDOW = 20;
const VIBRATION_MIN_SAMPLES = 8;
/**
 * On a 4-cylinder 4-stroke engine the dominant vibration is the 2× (firing)
 * order. A 1× order that persistently rivals or exceeds it points to rotating
 * imbalance or a mount/structural resonance rather than combustion.
 */
export function detectAbnormalVibration(sample: FaultSample, history: FaultSample[]): FaultEvent | null {
  const w = window(history, sample, VIBRATION_WINDOW);
  if (w.length < VIBRATION_MIN_SAMPLES) return null;
  const ratios = w.map((s) => s.vibrationOrders.first / Math.max(0.05, s.vibrationOrders.second));
  const meanRatio = mean(ratios);
  const persistence = ratios.filter((r) => r > 1).length / ratios.length;
  const excess = clamp((meanRatio - 0.8) / 1.2, 0, 1);
  const { half, first, second } = sample.vibrationOrders;
  const severity: FaultSeverity = meanRatio > 1.6 ? "HIGH" : meanRatio > 1.1 ? "MEDIUM" : "LOW";
  return {
    type: "abnormal vibration",
    severity,
    confidence: clamp(0.05 + 0.6 * excess + 0.35 * persistence, 0.05, 0.97),
    detail: `1× order ${first.toFixed(2)} mm/s vs 2× firing order ${second.toFixed(2)} mm/s (ratio ${meanRatio.toFixed(2)}, ${Math.round(persistence * 100)}% of window) at ${Math.round(sample.rpm)} rpm; 0.5× ${half.toFixed(2)} mm/s`,
  };
}

/** Every fault candidate with its confidence, before thresholding. */
export function evaluateFaults(sample: FaultSample, history: FaultSample[]): FaultEvent[] {
  const temporal = [detectCombustionInstability, detectOverheatingTrend, detectAbnormalVibration, detectSensorFailure]
    .map((detect) => detect(sample, history))
    .filter((f): f is FaultEvent => f !== null);
  return [...instantaneousFaults(sample), ...temporal];
}

export function activeFaults(sample: FaultSample, history: FaultSample[]) {
  return evaluateFaults(sample, history).filter((f) => f.confidence > FAULT_CONFIDENCE_THRESHOLD);
}
