import type { TelemetryControls } from "./telemetry-controls";
import type { EngineSignals } from "./can-fd";
import { isaTemperatureC } from "./physics-baseline";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// Thermal soak: sustained operation above this stress level accumulates heat
// the cooling system can't reject, so CHT and oil temperature creep upward.
const SOAK_STRESS_THRESHOLD = 0.6;
const SOAK_RATE_C_PER_S = 0.35;
const SOAK_MAX_C = 45;
const SOAK_RECOVERY_TAU_S = 45;
// Structural mode excited by the 1× crank order.
const MOUNT_RESONANCE_RPM = 5850;
const MOUNT_RESONANCE_WIDTH_RPM = 250;
// Cylinder-3 bias above this starts producing cycle-to-cycle combustion scatter.
const UNSTABLE_BIAS_ONSET = 30;

/** Deterministic PRNG (mulberry32) so simulated combustion scatter is reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type EngineSimulator = { sample(controls: TelemetryControls, tSeconds: number): EngineSignals };

/** 24 equivalent flight hours pass in three real minutes; wear then plateaus. */
export const ENDURANCE_HOURS_PER_REAL_SECOND = 24 / 180;
export function enduranceHours(startedAtMs: number, nowMs: number) {
  return Math.max(0, (nowMs - startedAtMs) / 1000 * ENDURANCE_HOURS_PER_REAL_SECOND);
}

/** Wear is distributed across all cylinders, unlike a cylinder-bias fault. */
export function createEnduranceEngineSimulator(getHours: () => number, seed = 42): EngineSimulator {
  const base = createEngineSimulator(seed);
  return {
    sample(controls, t) {
      const s = base.sample({ ...controls, cylinderBias: 0 }, t);
      const wear = clamp(getHours() / 24, 0, 1);
      return {
        ...s,
        oilPressure: Number(clamp(s.oilPressure - 12 * wear, 0, 40).toFixed(1)),
        oilTemp: Math.round(s.oilTemp + 16 * wear),
        cht1: Math.round(s.cht1 + 32 * wear),
        cht2: Math.round(s.cht2 + 34 * wear),
        cht3: Math.round(s.cht3 + 33 * wear),
        cht4: Math.round(s.cht4 + 35 * wear),
        egt1: Math.round(s.egt1 + 36 * wear),
        egt2: Math.round(s.egt2 + 38 * wear),
        egt3: Math.round(s.egt3 + 37 * wear),
        egt4: Math.round(s.egt4 + 39 * wear),
        vibration: Number((s.vibration + 3.6 * wear).toFixed(2)),
        vibOrder1: Number((s.vibOrder1 + 1.9 * wear).toFixed(2)),
      };
    },
  };
}

/** The simulated engine plant. Holds thermal-soak state, so one instance models one physical engine. */
export function createEngineSimulator(seed = 42): EngineSimulator {
  const random = mulberry32(seed);
  let soakC = 0;
  let lastT: number | null = null;

  return {
    sample({ rpm, map, altitude, ambientC, cylinderBias: bias }, t) {
      const ambientStressC = Math.max(0, ambientC - isaTemperatureC(altitude)) * 0.4;
      const stress = Math.max(0, (rpm - 4800) / 2400) + Math.max(0, map - 0.72) * 1.4;
      const dt = lastT === null ? 0 : clamp(t - lastT, 0, 1);
      lastT = t;
      const excess = stress - SOAK_STRESS_THRESHOLD;
      soakC = excess > 0 ? Math.min(SOAK_MAX_C, soakC + SOAK_RATE_C_PER_S * excess * dt) : soakC * Math.exp(-dt / SOAK_RECOVERY_TAU_S);

      const resonance = 1.6 * Math.exp(-(((rpm - MOUNT_RESONANCE_RPM) / MOUNT_RESONANCE_WIDTH_RPM) ** 2));
      const instability = Math.max(0, bias - UNSTABLE_BIAS_ONSET) * 0.35 + Math.max(0, 0.5 - map) * 30;

      const oilPressure = Number(clamp(31 - stress * 5.2 - bias * 0.12 + Math.sin(t * 3) * 0.25, 18, 34).toFixed(1));
      const vibration = Number((2.1 + stress * 1.8 + bias / 30 + resonance * 0.4 + Math.abs(Math.sin(t * 4)) * 0.45).toFixed(2));
      const fuelFlow = Number((18 + rpm / 620 + map * 9 + bias / 12 + Math.sin(t * 2) * 0.12).toFixed(2));
      const batteryVoltage = Number((27.7 + Math.sin(t * 1.8) * 0.18 - Math.max(0, vibration - 4) * 0.2).toFixed(2));
      const alternatorHealth = Math.round(clamp(99 - Math.max(0, 28 - batteryVoltage) * 8 - Math.max(0, vibration - 4) * 4, 65, 100));
      const injectionTiming = Number((18.5 + Math.sin(t * 1.3) * 0.22 - bias / 140).toFixed(2));
      const oilTemp = Math.round(94 + stress * 13 + soakC * 0.6 + ambientStressC);
      const rpmStress = Math.max(0, (rpm - 4800) / 2400);
      const cht = [214, 216, 213, 215].map((v, i) => Math.round(v + bias * (i === 2 ? 0.8 : 0.03) + rpmStress * (i + 1) + soakC + ambientStressC));
      const egt = [808, 821, 836, 830].map((v, i) => {
        const scatter = (random() * 2 - 1) * (i === 2 ? instability : instability * 0.15);
        return Math.round(v + rpmStress * (i + 2) * 5 + scatter + ambientStressC);
      });

      return {
        rpm, map, altitude, fuelFlow, injectionTiming,
        cht1: cht[0], cht2: cht[1], cht3: cht[2], cht4: cht[3],
        egt1: egt[0], egt2: egt[1], egt3: egt[2], egt4: egt[3],
        oilPressure, oilTemp, vibration, batteryVoltage, alternatorHealth,
        vibOrderHalf: Number((0.12 + Math.max(0, bias - UNSTABLE_BIAS_ONSET) / 60 + Math.abs(Math.sin(t * 1.1)) * 0.04).toFixed(2)),
        vibOrder1: Number((0.35 + 0.25 * stress + resonance + Math.abs(Math.sin(t * 1.7)) * 0.06).toFixed(2)),
        vibOrder2: Number((0.8 + 0.3 * stress + Math.abs(Math.sin(t * 2.3)) * 0.05).toFixed(2)),
      };
    },
  };
}
