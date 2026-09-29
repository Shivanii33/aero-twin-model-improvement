/**
 * First-principles thermal baseline for the 4-cylinder engine.
 *
 * The baseline predicts what CHT, EGT and oil temperature *should* read for a
 * given RPM / MAP / altitude if the engine is healthy. It is anchored to one
 * calibrated reference cruise point and scaled away from it with standard
 * relations:
 *
 *  - ISA troposphere (ICAO Doc 7488):  T = T₀ − L·h,  σ = ρ/ρ₀ = (1 − 6.87559e-6·h[ft])^4.2559
 *  - Ideal gas intake charge density:   ρ_charge ∝ MAP / T_intake   (intake ≈ ambient temperature)
 *  - Fuel power at constant mixture:    P ∝ ṁ_air ∝ ρ_charge · RPM   (volumetric efficiency held constant)
 *  - Forced-convection cooling at constant indicated airspeed: ṁ_cool ∝ √σ,
 *    Nu ∝ Re^0.8 ⇒ h ∝ σ^0.4 — thinner air cools less.
 *  - Temperature rise over ambient scales weakly with load (power-law
 *    exponents below were fitted to the reference cruise envelope).
 *
 * Residual = measured − expected. Because every cylinder shares the same
 * operating point, the *spread* of residuals across cylinders is insensitive
 * to calibration error in the absolute baseline, so it is the primary signal
 * fed to the anomaly pipeline.
 */
import type { PhysicsSnapshot } from "../shared/telemetry";

export const REFERENCE_CRUISE = { rpm: 5200, map: 0.84, altitudeFt: 8200 } as const;
export const CALIBRATION_ENVELOPE = {
  rpm: [4000, 7200],
  map: [0.5, 1.4],
  altitudeFt: [0, 16000],
} as const;

const ISA_SEA_LEVEL_TEMP_C = 15;
const ISA_LAPSE_C_PER_FT = 0.0019812;
const ISA_TROPOPAUSE_FT = 36089;
const KELVIN = 273.15;

// Healthy-engine readings measured at REFERENCE_CRUISE.
const REFERENCE_CHT_C = 215;
const REFERENCE_EGT_C = 827;
const REFERENCE_OIL_TEMP_C = 98.4;
// Per-cylinder offsets from the engine mean at the reference point (cooling
// baffle and intake-runner asymmetry). They sum to zero.
const CHT_CYLINDER_OFFSET_C = [-0.5, 1.5, -1.5, 0.5];
const EGT_CYLINDER_OFFSET_C = [-17, -3, 13, 7];

const CHT_LOAD_EXPONENT = 0.06;
const EGT_RPM_EXPONENT = 0.06;
const EGT_CHARGE_EXPONENT = 0.02;
const OIL_LOAD_EXPONENT = 0.2;
const OIL_FRICTION_SHARE = 0.05;
const COOLING_DENSITY_EXPONENT = 0.4;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

export function isaTemperatureC(altitudeFt: number) {
  const h = clamp(altitudeFt, 0, ISA_TROPOPAUSE_FT);
  return ISA_SEA_LEVEL_TEMP_C - ISA_LAPSE_C_PER_FT * h;
}

export function isaDensityRatio(altitudeFt: number) {
  const h = clamp(altitudeFt, 0, ISA_TROPOPAUSE_FT);
  return (1 - 6.87559e-6 * h) ** 4.2559;
}

export type BaselineInput = { rpm: number; map: number; altitude: number; ambientC: number };

export type ThermalBaseline = {
  densityRatio: number;
  ambientTempC: number;
  chargeDensityRatio: number;
  withinCalibration: boolean;
  cht: number[];
  egt: number[];
  oilTemp: number;
};

export function computeBaseline(input: BaselineInput): ThermalBaseline {
  const { rpm, map, altitude } = input;
  const ref = REFERENCE_CRUISE;
  const ambientC = input.ambientC;
  const refAmbientC = isaTemperatureC(ref.altitudeFt);
  const sigma = isaDensityRatio(altitude);
  const refSigma = isaDensityRatio(ref.altitudeFt);

  const rpmRatio = Math.max(300, rpm) / ref.rpm;
  const chargeDensityRatio = (Math.max(0.1, map) / ref.map) * ((refAmbientC + KELVIN) / (ambientC + KELVIN));
  const loadRatio = chargeDensityRatio * rpmRatio;
  const coolingRatio = (sigma / refSigma) ** COOLING_DENSITY_EXPONENT;

  const chtRise = ((REFERENCE_CHT_C - refAmbientC) * loadRatio ** CHT_LOAD_EXPONENT) / coolingRatio;
  const egtRise = (REFERENCE_EGT_C - refAmbientC) * rpmRatio ** EGT_RPM_EXPONENT * chargeDensityRatio ** EGT_CHARGE_EXPONENT;
  const oilHeat = OIL_FRICTION_SHARE * rpmRatio ** 2 + (1 - OIL_FRICTION_SHARE) * loadRatio ** OIL_LOAD_EXPONENT;
  const oilRise = ((REFERENCE_OIL_TEMP_C - refAmbientC) * oilHeat) / coolingRatio;

  const env = CALIBRATION_ENVELOPE;
  const withinCalibration =
    rpm >= env.rpm[0] && rpm <= env.rpm[1] && map >= env.map[0] && map <= env.map[1] && altitude >= env.altitudeFt[0] && altitude <= env.altitudeFt[1];

  return {
    densityRatio: Number(sigma.toFixed(4)),
    ambientTempC: round1(ambientC),
    chargeDensityRatio: Number(chargeDensityRatio.toFixed(4)),
    withinCalibration,
    cht: CHT_CYLINDER_OFFSET_C.map((offset) => round1(ambientC + chtRise + offset)),
    egt: EGT_CYLINDER_OFFSET_C.map((offset) => round1(ambientC + egtRise + offset)),
    oilTemp: round1(ambientC + oilRise),
  };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Largest deviation of any element from the median — the cylinder-to-cylinder spread. */
export function spatialDeviation(residuals: number[]) {
  const m = median(residuals);
  return Math.max(...residuals.map((r) => Math.abs(r - m)));
}

// Residual magnitudes that saturate the physics score. A 25 °C single-cylinder
// CHT split or 40 °C EGT split is well beyond normal cylinder-to-cylinder scatter.
const CHT_SPATIAL_FULL_SCALE_C = 25;
const EGT_SPATIAL_FULL_SCALE_C = 40;
const OIL_EXCESS_FULL_SCALE_C = 20;

export function computeResiduals(
  measured: { cht: number[]; egt: number[]; oilTemp: number },
  baseline: ThermalBaseline,
): PhysicsSnapshot {
  const cht = measured.cht.map((v, i) => round1(v - baseline.cht[i]));
  const egt = measured.egt.map((v, i) => round1(v - baseline.egt[i]));
  const oilTemp = round1(measured.oilTemp - baseline.oilTemp);
  const chtSpatial = round1(spatialDeviation(cht));
  const egtSpatial = round1(spatialDeviation(egt));
  const residualScore = Math.max(
    clamp(chtSpatial / CHT_SPATIAL_FULL_SCALE_C, 0, 1),
    clamp(egtSpatial / EGT_SPATIAL_FULL_SCALE_C, 0, 1),
    clamp(oilTemp / OIL_EXCESS_FULL_SCALE_C, 0, 1),
  );
  return {
    model: "ISA + ideal-gas thermal baseline",
    densityRatio: baseline.densityRatio,
    ambientTempC: baseline.ambientTempC,
    chargeDensityRatio: baseline.chargeDensityRatio,
    withinCalibration: baseline.withinCalibration,
    expected: { cht: baseline.cht, egt: baseline.egt, oilTemp: baseline.oilTemp },
    residuals: { cht, egt, oilTemp, chtSpatial, egtSpatial },
    residualScore: Number(residualScore.toFixed(3)),
  };
}
