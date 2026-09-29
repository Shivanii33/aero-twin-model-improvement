export type FaultSeverity = "LOW" | "MEDIUM" | "HIGH";
export type MaintenanceAdvisory = {
  component: string;
  urgency: "MONITOR" | "SCHEDULE" | "IMMEDIATE";
  hoursToAction: number;
  action: string;
  evidence: string;
};

export const FAULT_TYPES = [
  "misfire",
  "injector abnormality",
  "coking/lubrication issue",
  "sensor drift",
  "sensor failure",
  "combustion instability",
  "overheating trend",
  "abnormal vibration",
] as const;
export type FaultType = (typeof FAULT_TYPES)[number];

export type FaultEvent = {
  type: FaultType;
  severity: FaultSeverity;
  confidence: number;
  detail: string;
};

export type PhysicsSnapshot = {
  model: string;
  /** ISA density ratio σ = ρ/ρ₀ at the current altitude. */
  densityRatio: number;
  ambientTempC: number;
  /** Intake charge density relative to the reference cruise point (ideal gas, ρ ∝ p/T). */
  chargeDensityRatio: number;
  /** True when the operating point is inside the envelope the baseline was calibrated over. */
  withinCalibration: boolean;
  expected: { cht: number[]; egt: number[]; oilTemp: number };
  residuals: {
    cht: number[];
    egt: number[];
    oilTemp: number;
    /** Largest deviation of any cylinder's residual from the median cylinder residual. */
    chtSpatial: number;
    egtSpatial: number;
  };
  /** 0–1 score derived only from physics residuals. */
  residualScore: number;
};

export type VibrationOrders = {
  /** 0.5× crank order (camshaft rate) — rises with single-cylinder combustion loss. */
  half: number;
  /** 1× crank order — rises with rotating imbalance / mount resonance. */
  first: number;
  /** 2× crank order — the normal firing frequency of a 4-cylinder, 4-stroke engine. */
  second: number;
};

export type EcuLinkState = "OK" | "DEGRADED" | "LOST";

/** Simulated FADEC-style command/response status. Not a real OEM ECU protocol. */
export type EcuStatus = {
  rpmTarget: number;
  fuelSchedule: number;
  ignitionTiming: number;
  heartbeat: number;
  faultWord: number;
  linkState: EcuLinkState;
};

export type CanFrameSummary = { id: string; name: string; dlc: number; data: string };

export type CanBusStatus = {
  bus: "CAN-FD";
  ecu: string;
  frameRate: number;
  /** Frames decoded on this stream since it opened. */
  frames: number;
  framesPerCycle: number;
  crcErrors: number;
  counterErrors: number;
  saturatedSignals: string[];
  lastFrames: CanFrameSummary[];
};
