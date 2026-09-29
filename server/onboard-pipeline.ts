import type { EngineSimulator } from "./engine-simulator";
import type { TelemetryControls } from "./telemetry-controls";
import { createDecoderState, decodeFrames, FRAME_SPECS } from "./can-fd";
import { computeBaseline, computeResiduals } from "./physics-baseline";
import { instantaneousFaults, type FaultSample } from "./fault-detection";
import { createEcuInterface, createSimulatedCanAdapter, type CanAdapter, type EcuAdapter } from "./ecu-interface";

export const TICK_INTERVAL_MS = 150;

/** Only decoded engineering values and instantaneous evidence cross the link; no raw CAN frames or model artifacts. */
export function createOnboardPipeline(engine: EngineSimulator, canAdapter: CanAdapter = createSimulatedCanAdapter(engine), ecu: EcuAdapter = createEcuInterface()) {
  const decoder = createDecoderState();
  return {
    next(controls: TelemetryControls, nowMs = Date.now()) {
      const t = nowMs / 1000;
      const ecuStatus = ecu.step(controls, t);
      const { frames, saturated } = canAdapter.readCycle(controls, t);
      const s = decodeFrames(frames, decoder);
      const physics = computeResiduals(
        { cht: [s.cht1, s.cht2, s.cht3, s.cht4], egt: [s.egt1, s.egt2, s.egt3, s.egt4], oilTemp: s.oilTemp },
        computeBaseline({ rpm: s.rpm, map: s.map, altitude: s.altitude, ambientC: controls.ambientC }),
      );
      const sample: FaultSample = {
        t, rpm: s.rpm, fuelFlow: s.fuelFlow, injectionTiming: s.injectionTiming, vibration: s.vibration,
        vibrationOrders: { half: s.vibOrderHalf, first: s.vibOrder1, second: s.vibOrder2 },
        oilPressure: s.oilPressure, oilTemp: s.oilTemp, egtResidual: physics.residuals.egt,
        chtResidualMean: physics.residuals.cht.reduce((a, b) => a + b, 0) / 4,
        oilTempResidual: physics.residuals.oilTemp,
      };
      return {
        ts: new Date(nowMs).toISOString(), signals: s, physics, sample,
        immediateFaults: instantaneousFaults(sample), ecu: ecuStatus,
        can: {
          bus: "CAN-FD" as const, ecu: "AP04-ECU", frameRate: Math.round((1000 / TICK_INTERVAL_MS) * FRAME_SPECS.length),
          frames: decoder.decoded, framesPerCycle: FRAME_SPECS.length, crcErrors: decoder.crcErrors,
          counterErrors: decoder.counterErrors, saturatedSignals: saturated,
        },
      };
    },
  };
}

export type OnboardPayload = ReturnType<ReturnType<typeof createOnboardPipeline>["next"]>;
