import type { TelemetryControls } from "./telemetry-controls";
import type { EcuStatus } from "../shared/telemetry";
import type { EngineSimulator } from "./engine-simulator";
import { createEncoderState, encodeFrames, type CanFdFrame } from "./can-fd";

/** Adapter boundary for a SocketCAN / python-can bridge: provide a complete cycle of validated 29-bit CAN-FD frames. */
export interface CanAdapter {
  readCycle(controls: TelemetryControls, tSeconds: number): { frames: CanFdFrame[]; saturated: string[] };
}

export interface EcuAdapter {
  step(controls: TelemetryControls, tSeconds: number): EcuStatus;
}

export function createSimulatedCanAdapter(engine: EngineSimulator): CanAdapter {
  const encoder = createEncoderState();
  return { readCycle: (controls, tSeconds) => encodeFrames(engine.sample(controls, tSeconds), encoder) };
}


const FAULT_BIT = {
  HEARTBEAT_STALE: 1 << 0,
  COMMAND_OUT_OF_RANGE: 1 << 1,
  TIMING_DRIFT: 1 << 2,
} as const;

/**
 * Simulated FADEC-style command/response interface. This models a simplified
 * throttle-command -> engine-command contract, NOT a real OEM ECU/FADEC protocol.
 * It sits between the operator throttle controls and the engine simulator, and
 * produces the commanded RPM/fuel/timing values the simulator responds to, plus
 * a heartbeat and fault-word for link-health monitoring.
 */
export function createEcuInterface(): EcuAdapter {
  let heartbeat = 0;
  let lastRpmTarget = 5203;

  return {
    step(controls: TelemetryControls, tSeconds: number): EcuStatus {
      heartbeat = (heartbeat + 1) % 65536;

      const rpmTarget = controls.rpm;
      const fuelSchedule = Number((18 + rpmTarget / 620 + controls.map * 9).toFixed(2));
      const ignitionTiming = Number((18.5 + Math.sin(tSeconds * 1.3) * 0.22).toFixed(2));

      let faultWord = 0;
      const rpmJump = Math.abs(rpmTarget - lastRpmTarget);
      if (rpmJump > 2500) faultWord |= FAULT_BIT.COMMAND_OUT_OF_RANGE;
      lastRpmTarget = rpmTarget;

      const linkState: EcuStatus["linkState"] =
        faultWord === 0 ? "OK" : faultWord & FAULT_BIT.COMMAND_OUT_OF_RANGE ? "DEGRADED" : "LOST";

      return { rpmTarget, fuelSchedule, ignitionTiming, heartbeat, faultWord, linkState };
    },
  };
}
