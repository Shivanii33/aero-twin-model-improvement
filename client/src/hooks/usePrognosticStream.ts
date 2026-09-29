import { useEffect, useState } from "react";
import type { ModelPrediction } from "@shared/model";
import type { CanBusStatus, EcuStatus, PhysicsSnapshot, MaintenanceAdvisory } from "@shared/telemetry";

export type StreamControls = { rpm: number; map: number; altitude: number; cylinderBias: number; ambientC: number };
export type TelemetryPoint = { time: string; actual: number; baseline: number; residual: number };
export type AttentionPoint = { time: number; head: number; weight: number };
export type FaultEvent = { type: string; severity: string; confidence: number; detail: string };
export type TelemetrySnapshot = ModelPrediction & { ts: string; rpm: number; map: number; altitude: number; oilTemp: number; oilPressure: number; cht: number[]; egt: number[]; fuelFlow: number; vibration: number; batteryVoltage: number; alternatorHealth: number; injectionTiming: number; physics: PhysicsSnapshot; hybridAnomaly: number; edgeMode: boolean; faults: FaultEvent[]; advisories: MaintenanceAdvisory[]; can: CanBusStatus; ecu: EcuStatus; endurance?: { id: string; equivalentHours: number } };
export type EnduranceTrendPoint = { hours: number; health: number; rul: number; anomalyPercent: number; oilPressure: number; vibration: number; chtResidual: number; egtResidual: number };

/** The EGT residual chart tracks CYL 3, the cylinder the simulator biases. */
const TRACKED_CYLINDER = 2;

export function usePrognosticStream(controls: StreamControls, enduranceId: string | null = null, edgeMode: boolean = false) {
  const [history, setHistory] = useState<TelemetryPoint[]>([]);
  const [enduranceTrend, setEnduranceTrend] = useState<EnduranceTrendPoint[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot | null>(null);
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting">("connecting");
  useEffect(() => {
    setConnection("connecting");
    setHistory([]);
    setEnduranceTrend([]);
    const query = new URLSearchParams(Object.entries(controls).map(([key, value]) => [key, String(value)]));
    if (enduranceId) query.set("enduranceId", enduranceId);
    if (edgeMode) query.set("edgeMode", "true");
    const source = new EventSource(`/api/telemetry/stream?${query}`);
    let watchdog: ReturnType<typeof setTimeout>;
    source.onmessage = event => {
      try {
        const payload: TelemetrySnapshot = JSON.parse(event.data);
        if (![payload.health, payload.rul, payload.confidence, payload.anomaly].every(Number.isFinite) ||
          !payload.model || payload.cht?.length !== 4 || payload.egt?.length !== 4 || !Array.isArray(payload.outOfRangeFeatures) ||
          payload.physics?.expected?.egt?.length !== 4 || payload.physics?.residuals?.egt?.length !== 4) {
          throw new Error("Invalid model telemetry response");
        }
        setTelemetry(payload);
        setConnection("live");
        clearTimeout(watchdog);
        watchdog = setTimeout(() => setConnection("reconnecting"), 5000);
        const actual = payload.egt[TRACKED_CYLINDER];
        const baseline = payload.physics.expected.egt[TRACKED_CYLINDER];
        const residual = payload.physics.residuals.egt[TRACKED_CYLINDER];
        setHistory(previous => [...previous.slice(-49), { time: new Date(payload.ts).toLocaleTimeString(), actual, baseline, residual }]);
        if (payload.endurance?.id === enduranceId) {
          const point: EnduranceTrendPoint = {
            hours: payload.endurance.equivalentHours, health: payload.health, rul: payload.rul,
            anomalyPercent: Math.round(payload.hybridAnomaly * 100), oilPressure: payload.oilPressure, vibration: payload.vibration,
            chtResidual: payload.physics.residuals.cht.reduce((sum, value) => sum + value, 0) / 4,
            egtResidual: payload.physics.residuals.egt.reduce((sum, value) => sum + value, 0) / 4,
          };
          setEnduranceTrend(previous => previous.length && point.hours - previous[previous.length - 1].hours < 0.12
            ? previous : [...previous.slice(-179), point]);
        }
      } catch {
        setConnection("reconnecting");
      }
    };
    // EventSource automatically reconnects. Retain the last sample, but label it stale.
    source.onerror = () => setConnection("reconnecting");
    return () => { source.close(); clearTimeout(watchdog); };
  }, [controls.altitude, controls.ambientC, controls.cylinderBias, controls.map, controls.rpm, edgeMode, enduranceId]);
  return { telemetry, history, enduranceTrend, connection };
}
