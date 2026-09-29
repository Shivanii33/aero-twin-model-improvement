import type { TelemetryControls } from "./telemetry-controls";

export const SCENARIOS = {
  "high-altitude": { name: "High Altitude", phases: [
    { rpm: 4600, map: .76, altitude: 8000, ambientC: 4, cylinderBias: 0 },
    { rpm: 5300, map: .88, altitude: 12000, ambientC: -4, cylinderBias: 0 },
    { rpm: 5900, map: .98, altitude: 15500, ambientC: -9, cylinderBias: 0 },
  ] },
  "endurance-mission": { name: "Endurance Mission", phases: [
    { rpm: 4600, map: .72, altitude: 6500, ambientC: 18, cylinderBias: 0 },
    { rpm: 5100, map: .84, altitude: 8200, ambientC: 20, cylinderBias: 0 },
    { rpm: 5600, map: .92, altitude: 9500, ambientC: 22, cylinderBias: 0 },
  ] },
  "hot-weather": { name: "Hot-Weather Operation", phases: [
    { rpm: 4200, map: .72, altitude: 1200, ambientC: 38, cylinderBias: 0 },
    { rpm: 5500, map: .94, altitude: 2600, ambientC: 44, cylinderBias: 0 },
    { rpm: 6200, map: 1.04, altitude: 3400, ambientC: 48, cylinderBias: 0 },
  ] },
  "rapid-throttle": { name: "Rapid Throttle Transition", phases: [
    { rpm: 3200, map: .48, altitude: 4000, ambientC: 20, cylinderBias: 0 },
    { rpm: 7000, map: 1.12, altitude: 4000, ambientC: 20, cylinderBias: 0 },
    { rpm: 3500, map: .52, altitude: 4000, ambientC: 20, cylinderBias: 0 },
  ] },
} satisfies Record<string, { name: string; phases: TelemetryControls[] }>;
export type ScenarioId = keyof typeof SCENARIOS;
export function scenarioControls(id: ScenarioId, step: number, steps = 36): TelemetryControls {
  const phases = SCENARIOS[id].phases;
  const segment = Math.min(phases.length - 2, Math.floor(step / (steps / (phases.length - 1))));
  const t = Math.min(1, (step - segment * steps / (phases.length - 1)) / (steps / (phases.length - 1)));
  return Object.fromEntries(Object.keys(phases[0]).map(key => [key, Number((phases[segment][key as keyof TelemetryControls] * (1 - t) + phases[segment + 1][key as keyof TelemetryControls] * t).toFixed(2))])) as TelemetryControls;
}
