import type { StreamControls, TelemetrySnapshot } from "../hooks/usePrognosticStream";
import { MAJOR_PARTS, type EnginePartId } from "./engineParts";

export type PartState = "NOMINAL" | "WATCH" | "CRITICAL" | "NO SENSOR" | "READING" | "UNAVAILABLE";
export type EnginePart = {
  id: EnginePartId; label: string; metric: string; value: string; safe: string;
  state: PartState; history: string[]; material: string; purpose: string; why: string;
};
export type Connection = "connecting" | "live" | "reconnecting";
export type ReadingSource = `telemetry.${string}` | `controls.${keyof StreamControls}`;
export type LiveReading = { label: string; value: number | undefined; source: ReadingSource; unit: string; digits: number; scale?: number };
export const ENGINE_LIMITS = { egtWatch: 840, egtCritical: 850, oilPressureWatch: 29, oilPressureCritical: 25, oilTempWatch: 108, oilTempCritical: 112, mapWatch: 1 } as const;
export const formatReading = (value: number | undefined | null, digits = 1) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";

export function assertReadingProvenance(readings: LiveReading[], telemetry: TelemetrySnapshot | null, controls: StreamControls, dev = import.meta.env?.DEV) {
  if (!dev) return;
  for (const reading of readings) {
    const [root, ...path] = reading.source.split(".");
    let source: unknown = root === "telemetry" ? telemetry : root === "controls" ? controls : undefined;
    for (const key of path) source = source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;
    const expected = typeof source === "number" ? source * (reading.scale ?? 1) : undefined;
    if (!Object.is(reading.value, expected)) console.warn("[EngineViewport3D] Reading not derived from props", reading.label, reading.source);
  }
}

export function engineReadings(t: TelemetrySnapshot | null, controls: StreamControls): LiveReading[] {
  const readings: LiveReading[] = [
    { label: "Health", value: t?.health, source: "telemetry.health", unit: "%", digits: 1 },
    { label: "Remaining life", value: t?.rul, source: "telemetry.rul", unit: "h", digits: 1 },
    { label: "Confidence", value: t?.confidence, source: "telemetry.confidence", unit: "%", digits: 1 },
    { label: "Hybrid anomaly", value: t ? t.hybridAnomaly * 100 : undefined, source: "telemetry.hybridAnomaly", scale: 100, unit: "%", digits: 1 },
    { label: "Crank speed", value: t?.rpm, source: "telemetry.rpm", unit: "rpm", digits: 0 },
    { label: "Vibration · Engine-wide", value: t?.vibration, source: "telemetry.vibration", unit: "mm/s", digits: 2 },
    { label: "Oil pressure · Engine-wide", value: t?.oilPressure, source: "telemetry.oilPressure", unit: "psi", digits: 1 },
  ];
  assertReadingProvenance(readings, t, controls);
  return readings;
}

const purposes: Record<EnginePartId, string> = {
  "cyl-1": "Where fuel burns to make power.", "cyl-2": "Where fuel burns to make power.", "cyl-3": "Where fuel burns to make power.", "cyl-4": "Where fuel burns to make power.",
  heads: "Seals each combustion chamber and carries the valves.", fins: "Sheds heat into the passing air.",
  crankcase: "Supports the crankshaft and routes lubricating oil.", manifold: "Delivers air to the combustion chambers.",
  exhaust: "Carries burned gases away from the engine.", oil: "Circulates oil to lubricate and cool moving parts.",
  fuel: "Meters fuel to the cylinders.", ecu: "Coordinates fuel and ignition through the engine data bus.",
  gearbox: "Reduces engine speed for the propeller.", shaft: "Transfers engine torque to the propeller.", propeller: "Turns engine power into thrust.",
};
export function deriveEngineParts(t: TelemetrySnapshot | null, controls: StreamControls): EnginePart[] {
  const values: LiveReading[] = [];
  const read = (label: string, value: number | undefined, source: ReadingSource, unit: string, digits = 1) => {
    values.push({ label, value, source, unit, digits });
    return `${formatReading(value, digits)} ${unit}`;
  };
  const result = MAJOR_PARTS.map((catalog): EnginePart => {
    const part: EnginePart = { id: catalog.id, label: catalog.name, material: catalog.mat, purpose: purposes[catalog.id], metric: "Live sensor", value: "—", safe: "Not instrumented", state: "NO SENSOR", history: [], why: "No live sensor for this part" };
    if (catalog.id.startsWith("cyl-")) {
      const i = Number(catalog.id.slice(-1)) - 1;
      const egt = t?.egt[i], cht = t?.cht[i];
      part.metric = "CHT / EGT";
      part.value = `${read("CHT", cht, `telemetry.cht.${i}`, "°C")} / ${read("EGT", egt, `telemetry.egt.${i}`, "°C")}`;
      part.safe = "CHT < 225 °C · EGT ≤ 840 °C";
      part.state = egt == null ? "UNAVAILABLE" : egt > ENGINE_LIMITS.egtCritical ? "CRITICAL" : egt > ENGINE_LIMITS.egtWatch ? "WATCH" : "NOMINAL";
      part.why = egt == null ? "Waiting for cylinder telemetry." : egt > ENGINE_LIMITS.egtWatch
        ? `Exhaust gas is ${formatReading(egt - ENGINE_LIMITS.egtWatch)} °C above normal; ${part.state === "CRITICAL" ? "inspect promptly" : "watch it"}. EGT ${formatReading(egt)} °C > ${part.state === "CRITICAL" ? ENGINE_LIMITS.egtCritical : ENGINE_LIMITS.egtWatch} °C ${part.state.toLowerCase()} threshold. CHT is shown, but does not set this colour.`
        : `EGT ${formatReading(egt)} °C is at or below the ${ENGINE_LIMITS.egtWatch} °C watch threshold. CHT is shown, but does not set this colour.`;
    } else if (catalog.id === "crankcase" || catalog.id === "oil" || catalog.id === "manifold") {
      const pressure = catalog.id === "crankcase", intake = catalog.id === "manifold";
      const value = intake ? controls.map : pressure ? t?.oilPressure : t?.oilTemp;
      const watch = intake ? ENGINE_LIMITS.mapWatch : pressure ? ENGINE_LIMITS.oilPressureWatch : ENGINE_LIMITS.oilTempWatch;
      const critical = pressure ? ENGINE_LIMITS.oilPressureCritical : ENGINE_LIMITS.oilTempCritical;
      part.metric = intake ? "MAP / engine load" : pressure ? "Oil pressure · Engine-wide" : "Oil temperature";
      part.value = read(part.metric, value, intake ? "controls.map" : pressure ? "telemetry.oilPressure" : "telemetry.oilTemp", intake ? "bar" : pressure ? "psi" : "°C", intake ? 2 : 1);
      part.safe = intake ? "0.42–1.08 bar; watch above 1 bar" : pressure ? "29–35 psi" : "85–108 °C";
      part.state = value == null ? "UNAVAILABLE" : intake ? value > watch ? "WATCH" : "NOMINAL" : pressure ? value < critical ? "CRITICAL" : value < watch ? "WATCH" : "NOMINAL" : value > critical ? "CRITICAL" : value > watch ? "WATCH" : "NOMINAL";
      part.why = value == null ? "Waiting for telemetry." : `${part.metric}: ${part.value}. ${part.state === "NOMINAL" ? "No watch threshold crossed" : `${pressure ? "Below" : "Above"} the ${part.state === "CRITICAL" ? critical : watch} ${intake ? "bar" : pressure ? "psi" : "°C"} ${part.state.toLowerCase()} threshold`}.`;
    } else if (catalog.id === "fuel") {
      part.metric = "Fuel flow"; part.value = read("Fuel flow", t?.fuelFlow, "telemetry.fuelFlow", "L/h");
      part.state = t?.fuelFlow == null ? "UNAVAILABLE" : "READING"; part.safe = "No configured health threshold";
      part.why = "Live fuel flow is shown without a health colour: no threshold is configured.";
    } else if (catalog.id === "ecu") {
      const link = t?.ecu?.linkState;
      part.metric = "ECU link / CAN errors";
      part.value = `${link ?? "—"} · CRC ${read("CRC errors", t?.can?.crcErrors, "telemetry.can.crcErrors", "", 0)} · Counter ${read("Counter errors", t?.can?.counterErrors, "telemetry.can.counterErrors", "", 0)}`;
      part.state = !link ? "UNAVAILABLE" : link === "LOST" ? "CRITICAL" : link === "DEGRADED" ? "WATCH" : "NOMINAL";
      part.safe = "ECU link OK; CAN counts are informational";
      part.why = link ? `Colour follows telemetry.ecu.linkState = ${link}. CAN CRC and counter totals are displayed without inventing an error-count threshold.` : "Waiting for ECU link telemetry.";
    }
    part.history = [part.state === "NO SENSOR" ? part.why : `Selected sample · ${part.metric}: ${part.value}`];
    return part;
  });
  assertReadingProvenance(values, t, controls);
  return result;
}
