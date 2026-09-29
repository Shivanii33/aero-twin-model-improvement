import type { FaultEvent } from "../shared/telemetry";
import type { TelemetryControls } from "./telemetry-controls";
import { createOnboardPipeline, TICK_INTERVAL_MS, type OnboardPayload } from "./onboard-pipeline";
import { predictTelemetry, fuseAnomaly } from "./model";
import {
  detectCombustionInstability, detectOverheatingTrend, detectAbnormalVibration, detectSensorFailure,
  FAULT_CONFIDENCE_THRESHOLD, FAULT_HISTORY_LENGTH, type FaultSample,
} from "./fault-detection";
import { recommendMaintenance } from "./maintenance-advisory";
import type { EngineSimulator } from "./engine-simulator";

export { TICK_INTERVAL_MS };
const round3 = (n: number) => Number(n.toFixed(3));

/** The ground owns the RF model and per-source temporal history, never the onboard process. */
export function createGroundPipeline() {
  const history: FaultSample[] = [];
  return {
    process(input: OnboardPayload, edgeMode = false) {
      const { signals: s, physics, sample, can, ecu } = input;
      const prediction = predictTelemetry({
        rpm: s.rpm, manifold_pressure_bar: s.map, oil_temp_c: s.oilTemp, oil_press_bar: s.oilPressure / 14.5038,
        cht_cyl1: s.cht1, cht_cyl2: s.cht2, cht_cyl3_anomaly: s.cht3, cht_cyl4: s.cht4,
      });
      const temporal = [detectCombustionInstability, detectOverheatingTrend, detectAbnormalVibration, detectSensorFailure]
        .map(detect => detect(sample, history)).filter((f): f is FaultEvent => f !== null);
      const faultCandidates = [...input.immediateFaults, ...temporal].map(f => ({ ...f, confidence: round3(f.confidence) }));
      history.push(sample);
      if (history.length > FAULT_HISTORY_LENGTH) history.shift();
      const faults = faultCandidates.filter(f => f.confidence > FAULT_CONFIDENCE_THRESHOLD);
      return {
        ts: input.ts,
        rpm: s.rpm, map: s.map, altitude: s.altitude,
        fuelFlow: s.fuelFlow, vibration: s.vibration, batteryVoltage: s.batteryVoltage, alternatorHealth: s.alternatorHealth,
        injectionTiming: s.injectionTiming, oilTemp: s.oilTemp, oilPressure: s.oilPressure,
        cht: [s.cht1, s.cht2, s.cht3, s.cht4], egt: [s.egt1, s.egt2, s.egt3, s.egt4],
        vibrationOrders: { half: s.vibOrderHalf, first: s.vibOrder1, second: s.vibOrder2 },
        ...prediction, physics, hybridAnomaly: round3(fuseAnomaly(prediction.anomaly, physics.residualScore)),
        edgeMode, faults, faultCandidates, advisories: recommendMaintenance(prediction, faults),
        can: { ...can, lastFrames: [] }, ecu,
      };
    },
  };
}

export type TelemetryPipeline = { next(controls: TelemetryControls, nowMs?: number, edgeMode?: boolean): TelemetryPayload };
export type TelemetryPayload = ReturnType<ReturnType<typeof createGroundPipeline>["process"]>;

/** Single-process path retained for tests, scenarios and non-edge simulation. */
export function createTelemetryPipeline(engine: EngineSimulator): TelemetryPipeline {
  const onboard = createOnboardPipeline(engine);
  const ground = createGroundPipeline();
  return { next(controls, nowMs, edgeMode = false) { return ground.process(onboard.next(controls, nowMs), edgeMode); } };
}
