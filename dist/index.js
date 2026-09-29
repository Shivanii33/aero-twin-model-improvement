// server/index.ts
import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
import { DatabaseSync } from "node:sqlite";
import { randomUUID as randomUUID2 } from "node:crypto";

// server/model.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { RandomForestRegression } from "ml-random-forest";

// shared/model.ts
var FEATURE_NAMES = [
  "rpm",
  "manifold_pressure_bar",
  "oil_temp_c",
  "oil_press_bar",
  "cht_cyl1",
  "cht_cyl2",
  "cht_cyl3_anomaly",
  "cht_cyl4"
];

// server/model.ts
var SEED = 42;
var TRAIN_FRACTION = 0.8;
var PARAMETERS = { nEstimators: 64, maxFeatures: 6, maxDepth: 12, minNumSamples: 3 };
var VERSION = "TAPAS-RF-TREND-2.0";
var CONFIDENCE_METHOD = "Heuristic reliability score, not a calibrated probability: 100 \xD7 exp(\u22122 \xD7 (health tree standard deviation + RUL tree standard deviation / training RUL range + normalized range exceedance)). Capped at 50% for any out-of-range feature and 99% otherwise. Forest spread does not capture extrapolation uncertainty.";
var trained;
var clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function fitSlope(rows, target) {
  const xMean = rows.reduce((sum, row) => sum + row.oil_temp_c, 0) / rows.length;
  const yMean = rows.reduce((sum, row) => sum + row[target], 0) / rows.length;
  const covariance = rows.reduce((sum, row) => sum + (row.oil_temp_c - xMean) * (row[target] - yMean), 0);
  const variance = rows.reduce((sum, row) => sum + (row.oil_temp_c - xMean) ** 2, 0);
  return Math.min(0, variance ? covariance / variance : 0);
}
function fitEdgeTrend(train) {
  const tail = train.slice(-Math.max(10, Math.floor(train.length / 8)));
  const anchor = train.slice(-Math.max(5, Math.floor(train.length / 40)));
  const average = (key) => anchor.reduce((sum, row) => sum + row[key], 0) / anchor.length;
  return {
    anchorTemp: average("oil_temp_c"),
    health: average("target_health_index"),
    rul: average("target_rul_hours"),
    healthSlope: fitSlope(tail, "target_health_index"),
    rulSlope: fitSlope(tail, "target_rul_hours")
  };
}
function applyEdgeTrend(health, rul, oilTemp, trend) {
  if (oilTemp <= trend.anchorTemp) return { health: clamp(health, 0, 1), rul: Math.max(0, rul) };
  const excess = oilTemp - trend.anchorTemp;
  return {
    health: clamp(Math.min(health, trend.health + excess * trend.healthSlope), 0, 1),
    rul: Math.max(0, Math.min(rul, trend.rul + excess * trend.rulSlope))
  };
}
function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = Math.imul(1664525, value) + 1013904223 >>> 0;
    return value / 4294967296;
  };
}
function shuffled(values, seed) {
  const result = [...values];
  const next = random(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function scoreRegression(actual, predicted, unit) {
  if (!actual.length || actual.length !== predicted.length || [...actual, ...predicted].some((v) => !Number.isFinite(v))) {
    throw new Error("Regression metrics require equally sized, finite, nonempty arrays.");
  }
  const mean2 = actual.reduce((sum, value) => sum + value, 0) / actual.length;
  const squaredError = actual.reduce((sum, value, i) => sum + (value - predicted[i]) ** 2, 0);
  const totalVariance = actual.reduce((sum, value) => sum + (value - mean2) ** 2, 0);
  return {
    mae: actual.reduce((sum, value, i) => sum + Math.abs(value - predicted[i]), 0) / actual.length,
    rmse: Math.sqrt(squaredError / actual.length),
    r2: totalVariance === 0 ? null : 1 - squaredError / totalVariance,
    unit
  };
}
var vector = (row) => FEATURE_NAMES.map((name) => row[name]);
function timeOrderedSplit(rows, trainFraction) {
  const ordered = [...rows].sort((a, b) => a.timestamp_sec - b.timestamp_sec);
  const trainCount = Math.floor(ordered.length * trainFraction);
  return { train: ordered.slice(0, trainCount), test: ordered.slice(trainCount) };
}
function initializeModel() {
  if (trained) return trained.metrics;
  const started = performance.now();
  const datasetPath = fileURLToPath(new URL("../tapas_extended_ml_dataset.csv", import.meta.url));
  const csv = readFileSync(datasetPath, "utf8");
  const parsed = Papa.parse(csv, { header: true, dynamicTyping: true, skipEmptyLines: "greedy" });
  const columns = [...FEATURE_NAMES, "timestamp_sec", "target_health_index", "target_rul_hours"];
  if (parsed.errors.length || columns.some((name) => !parsed.meta.fields?.includes(name))) {
    throw new Error(`Invalid TAPAS CSV: ${parsed.errors[0]?.message ?? "missing required columns"}`);
  }
  if (parsed.data.length < 10) throw new Error("TAPAS dataset needs at least 10 valid rows.");
  parsed.data.forEach((row, index) => {
    if (columns.some((name) => typeof row[name] !== "number" || !Number.isFinite(row[name])) || row.target_health_index < 0 || row.target_health_index > 1 || row.target_rul_hours < 0) {
      throw new Error(`Invalid numeric data or target at CSV row ${index + 2}`);
    }
  });
  const rows = parsed.data;
  const { train, test } = timeOrderedSplit(rows, TRAIN_FRACTION);
  const trainX = train.map(vector);
  const testX = test.map(vector);
  const options = {
    seed: SEED,
    nEstimators: PARAMETERS.nEstimators,
    maxFeatures: PARAMETERS.maxFeatures,
    replacement: false,
    useSampleBagging: true,
    noOOB: true,
    selectionMethod: "mean",
    treeOptions: { maxDepth: PARAMETERS.maxDepth, minNumSamples: PARAMETERS.minNumSamples }
  };
  const health = new RandomForestRegression(options);
  const rul = new RandomForestRegression({ ...options, seed: SEED + 1 });
  health.train(trainX, train.map((row) => row.target_health_index));
  rul.train(trainX, train.map((row) => row.target_rul_hours));
  const actualHealth = test.map((row) => row.target_health_index);
  const actualRul = test.map((row) => row.target_rul_hours);
  const trend = fitEdgeTrend(train);
  const predictBatch = (xs) => {
    const h = health.predict(xs), r = rul.predict(xs);
    return xs.map((x, i) => applyEdgeTrend(h[i], r[i], x[2], trend));
  };
  const baselineTargets = {
    health: scoreRegression(actualHealth, health.predict(testX), "health index (0\u20131)"),
    rul: scoreRegression(actualRul, rul.predict(testX), "hours")
  };
  const corrected = predictBatch(testX);
  const targets = {
    health: scoreRegression(actualHealth, corrected.map((value) => value.health), "health index (0\u20131)"),
    rul: scoreRegression(actualRul, corrected.map((value) => value.rul), "hours")
  };
  const featureImportance = FEATURE_NAMES.map((feature, column) => {
    let healthDelta = 0, rulDelta = 0;
    for (let repeat = 0; repeat < 3; repeat++) {
      const permuted = shuffled(testX.map((row) => row[column]), SEED + column * 10 + repeat);
      const x = testX.map((row, i) => row.map((value, j) => j === column ? permuted[i] : value));
      const predictions = predictBatch(x);
      healthDelta += scoreRegression(actualHealth, predictions.map((value) => value.health), "").mae - targets.health.mae;
      rulDelta += scoreRegression(actualRul, predictions.map((value) => value.rul), "").mae - targets.rul.mae;
    }
    return { feature, health: healthDelta / 3, rul: rulDelta / 3 };
  });
  const features = FEATURE_NAMES.map((name) => ({ name, min: Math.min(...train.map((row) => row[name])), max: Math.max(...train.map((row) => row[name])) }));
  const metrics = {
    model: "Random Forest Regression",
    version: VERSION,
    trainedAt: (/* @__PURE__ */ new Date()).toISOString(),
    trainingMs: Math.round(performance.now() - started),
    dataset: { file: "tapas_extended_ml_dataset.csv", sha256: createHash("sha256").update(csv).digest("hex"), rows: rows.length, trainRows: train.length, testRows: test.length },
    split: {
      method: "Time-based holdout: earliest 80% of rows train, latest 20% test",
      seed: SEED,
      trainFraction: TRAIN_FRACTION,
      trainTimestampSec: [train[0].timestamp_sec, train[train.length - 1].timestamp_sec],
      testTimestampSec: [test[0].timestamp_sec, test[test.length - 1].timestamp_sec]
    },
    parameters: PARAMETERS,
    features,
    targets,
    baselineTargets,
    degradationMethod: `Training-only oil-temperature edge trend: least-squares nonpositive health and RUL slopes over the last ${Math.max(10, Math.floor(train.length / 8))} training rows, anchored to the mean of the last ${Math.max(5, Math.floor(train.length / 40))} training rows at ${trend.anchorTemp.toFixed(2)} \xB0C. Beyond the anchor, take the lower of the forest estimate and the extrapolated estimate, then clamp to physical bounds. No timestamp or holdout targets enter inference.`,
    featureImportance,
    importanceMethod: "Held-out permutation importance for the combined predictor: mean increase in MAE over 3 seeded permutations per feature. Diagnostic only; never used to select or tune this model. Raw signed deltas; correlated features can share importance.",
    confidenceMethod: CONFIDENCE_METHOD,
    limitations: [
      "Evaluation is a chronological holdout: the test set is the final 20% of one time-series CSV, i.e. a future segment never seen in training. It is still a single run, not independent-flight validation.",
      "Late-life health (0\u20130.56) and RUL (0\u20134.8 h) lie below training targets. The forest cannot extrapolate; a train-only oil-temperature tail slope provides bounded degradation estimates instead. The oil-temperature proxy may fail with different operating regimes, sensor faults or independent flights.",
      "Compared with the previous random-row split (health MAE \u2248 0.001, R\xB2 \u2248 0.9999), those near-perfect scores came from interpolating between adjacent correlated samples and overstated forecasting ability.",
      "timestamp_sec and both targets are excluded from inputs. The holdout is never used for fitting or tuning.",
      "Current simulator RPM and cylinder temperatures may exceed training ranges. Forests cannot reliably extrapolate; confidence is reduced and affected features are flagged.",
      "Confidence is an ensemble-spread heuristic, not a probability of safety. This demo is not validated for flight or maintenance decisions."
    ]
  };
  const trainRul = train.map((row) => row.target_rul_hours);
  const medians = FEATURE_NAMES.map((_, column) => [...trainX.map((x) => x[column])].sort((a, b) => a - b)[Math.floor(trainX.length / 2)]);
  trained = { health, rul, metrics, trend, medians, rulRange: Math.max(...trainRul) - Math.min(...trainRul) || 1 };
  console.info(`[model] ${VERSION}: ${train.length} training / ${test.length} held-out rows, ${metrics.trainingMs} ms`);
  console.table({ health: targets.health, rul: targets.rul });
  return metrics;
}
function getModelMetrics() {
  if (!trained) throw new Error("Model is not initialized.");
  return trained.metrics;
}
var std = (values) => {
  const mean2 = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean2) ** 2, 0) / values.length);
};
function predictTelemetry(input) {
  if (!trained) throw new Error("Model is not initialized.");
  const x = vector(input);
  if (x.some((value) => !Number.isFinite(value))) throw new Error("All model inputs must be finite numbers.");
  const estimate = (values) => applyEdgeTrend(trained.health.predict([values])[0], trained.rul.predict([values])[0], values[2], trained.trend);
  const { health: healthIndex, rul } = estimate(x);
  const contributions = FEATURE_NAMES.map((feature, column) => {
    const reference = trained.medians[column];
    const counterfactual = [...x];
    counterfactual[column] = reference;
    const alternate = estimate(counterfactual);
    return { feature, reference, health: healthIndex - alternate.health, rul: rul - alternate.rul };
  });
  const top = (target) => contributions.map(({ feature, reference, ...deltas }) => ({ feature, reference, delta: deltas[target] })).filter((item) => Math.abs(item.delta) > 1e-6).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
  const healthIndexStd = std(trained.health.predictionValues([x]).getRow(0));
  const rulHoursStd = std(trained.rul.predictionValues([x]).getRow(0));
  const outside = trained.metrics.features.filter(({ name, min, max }) => input[name] < min || input[name] > max);
  const rangePenalty = outside.reduce((sum, { name, min, max }) => sum + Math.max(min - input[name], input[name] - max, 0) / Math.max(max - min, 1e-4), 0);
  const confidence = Math.round(Math.min(outside.length ? 50 : 99, 100 * Math.exp(-2 * (healthIndexStd + rulHoursStd / trained.rulRange + rangePenalty))));
  const anomaly = 1 - healthIndex;
  return {
    health: Math.round(healthIndex * 100),
    healthIndex,
    rul,
    confidence,
    anomaly,
    validation: outside.length ? "OUT_OF_TRAINING_RANGE" : anomaly > 0.66 ? "CRITICAL_MODEL_RISK" : anomaly > 0.46 ? "DEGRADED_MODEL_RISK" : "IN_RANGE_ESTIMATE",
    model: VERSION,
    sampleCount: trained.metrics.dataset.rows,
    outOfRangeFeatures: outside.map(({ name }) => name),
    uncertainty: { healthIndexStd, rulHoursStd },
    explanations: {
      method: "Signed difference from this prediction when one feature is replaced with its training median; health deltas in index units, RUL deltas in hours. Local sensitivity, not causal attribution; correlated sensors and clipping can conceal influence.",
      health: top("health"),
      rul: top("rul")
    }
  };
}
var PHYSICS_RESIDUAL_WEIGHT = 0.6;
function fuseAnomaly(forestAnomaly, physicsResidualScore) {
  const f = Math.max(0, Math.min(1, forestAnomaly));
  const p = Math.max(0, Math.min(1, physicsResidualScore));
  return 1 - (1 - f) * (1 - PHYSICS_RESIDUAL_WEIGHT * p);
}

// server/physics-baseline.ts
var REFERENCE_CRUISE = { rpm: 5200, map: 0.84, altitudeFt: 8200 };
var CALIBRATION_ENVELOPE = {
  rpm: [4e3, 7200],
  map: [0.5, 1.4],
  altitudeFt: [0, 16e3]
};
var ISA_SEA_LEVEL_TEMP_C = 15;
var ISA_LAPSE_C_PER_FT = 19812e-7;
var ISA_TROPOPAUSE_FT = 36089;
var KELVIN = 273.15;
var REFERENCE_CHT_C = 215;
var REFERENCE_EGT_C = 827;
var REFERENCE_OIL_TEMP_C = 98.4;
var CHT_CYLINDER_OFFSET_C = [-0.5, 1.5, -1.5, 0.5];
var EGT_CYLINDER_OFFSET_C = [-17, -3, 13, 7];
var CHT_LOAD_EXPONENT = 0.06;
var EGT_RPM_EXPONENT = 0.06;
var EGT_CHARGE_EXPONENT = 0.02;
var OIL_LOAD_EXPONENT = 0.2;
var OIL_FRICTION_SHARE = 0.05;
var COOLING_DENSITY_EXPONENT = 0.4;
var clamp2 = (n, min, max) => Math.max(min, Math.min(max, n));
var round1 = (n) => Math.round(n * 10) / 10;
function isaTemperatureC(altitudeFt) {
  const h = clamp2(altitudeFt, 0, ISA_TROPOPAUSE_FT);
  return ISA_SEA_LEVEL_TEMP_C - ISA_LAPSE_C_PER_FT * h;
}
function isaDensityRatio(altitudeFt) {
  const h = clamp2(altitudeFt, 0, ISA_TROPOPAUSE_FT);
  return (1 - 687559e-11 * h) ** 4.2559;
}
function computeBaseline(input) {
  const { rpm, map, altitude } = input;
  const ref = REFERENCE_CRUISE;
  const ambientC = input.ambientC;
  const refAmbientC = isaTemperatureC(ref.altitudeFt);
  const sigma = isaDensityRatio(altitude);
  const refSigma = isaDensityRatio(ref.altitudeFt);
  const rpmRatio = Math.max(300, rpm) / ref.rpm;
  const chargeDensityRatio = Math.max(0.1, map) / ref.map * ((refAmbientC + KELVIN) / (ambientC + KELVIN));
  const loadRatio = chargeDensityRatio * rpmRatio;
  const coolingRatio = (sigma / refSigma) ** COOLING_DENSITY_EXPONENT;
  const chtRise = (REFERENCE_CHT_C - refAmbientC) * loadRatio ** CHT_LOAD_EXPONENT / coolingRatio;
  const egtRise = (REFERENCE_EGT_C - refAmbientC) * rpmRatio ** EGT_RPM_EXPONENT * chargeDensityRatio ** EGT_CHARGE_EXPONENT;
  const oilHeat = OIL_FRICTION_SHARE * rpmRatio ** 2 + (1 - OIL_FRICTION_SHARE) * loadRatio ** OIL_LOAD_EXPONENT;
  const oilRise = (REFERENCE_OIL_TEMP_C - refAmbientC) * oilHeat / coolingRatio;
  const env = CALIBRATION_ENVELOPE;
  const withinCalibration = rpm >= env.rpm[0] && rpm <= env.rpm[1] && map >= env.map[0] && map <= env.map[1] && altitude >= env.altitudeFt[0] && altitude <= env.altitudeFt[1];
  return {
    densityRatio: Number(sigma.toFixed(4)),
    ambientTempC: round1(ambientC),
    chargeDensityRatio: Number(chargeDensityRatio.toFixed(4)),
    withinCalibration,
    cht: CHT_CYLINDER_OFFSET_C.map((offset) => round1(ambientC + chtRise + offset)),
    egt: EGT_CYLINDER_OFFSET_C.map((offset) => round1(ambientC + egtRise + offset)),
    oilTemp: round1(ambientC + oilRise)
  };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function spatialDeviation(residuals) {
  const m = median(residuals);
  return Math.max(...residuals.map((r) => Math.abs(r - m)));
}
var CHT_SPATIAL_FULL_SCALE_C = 25;
var EGT_SPATIAL_FULL_SCALE_C = 40;
var OIL_EXCESS_FULL_SCALE_C = 20;
function computeResiduals(measured, baseline) {
  const cht = measured.cht.map((v, i) => round1(v - baseline.cht[i]));
  const egt = measured.egt.map((v, i) => round1(v - baseline.egt[i]));
  const oilTemp = round1(measured.oilTemp - baseline.oilTemp);
  const chtSpatial = round1(spatialDeviation(cht));
  const egtSpatial = round1(spatialDeviation(egt));
  const residualScore = Math.max(
    clamp2(chtSpatial / CHT_SPATIAL_FULL_SCALE_C, 0, 1),
    clamp2(egtSpatial / EGT_SPATIAL_FULL_SCALE_C, 0, 1),
    clamp2(oilTemp / OIL_EXCESS_FULL_SCALE_C, 0, 1)
  );
  return {
    model: "ISA + ideal-gas thermal baseline",
    densityRatio: baseline.densityRatio,
    ambientTempC: baseline.ambientTempC,
    chargeDensityRatio: baseline.chargeDensityRatio,
    withinCalibration: baseline.withinCalibration,
    expected: { cht: baseline.cht, egt: baseline.egt, oilTemp: baseline.oilTemp },
    residuals: { cht, egt, oilTemp, chtSpatial, egtSpatial },
    residualScore: Number(residualScore.toFixed(3))
  };
}

// server/engine-simulator.ts
var clamp3 = (n, min, max) => Math.max(min, Math.min(max, n));
var SOAK_STRESS_THRESHOLD = 0.6;
var SOAK_RATE_C_PER_S = 0.35;
var SOAK_MAX_C = 45;
var SOAK_RECOVERY_TAU_S = 45;
var MOUNT_RESONANCE_RPM = 5850;
var MOUNT_RESONANCE_WIDTH_RPM = 250;
var UNSTABLE_BIAS_ONSET = 30;
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var ENDURANCE_HOURS_PER_REAL_SECOND = 24 / 180;
function enduranceHours(startedAtMs, nowMs) {
  return Math.max(0, (nowMs - startedAtMs) / 1e3 * ENDURANCE_HOURS_PER_REAL_SECOND);
}
function createEnduranceEngineSimulator(getHours, seed = 42) {
  const base = createEngineSimulator(seed);
  return {
    sample(controls, t) {
      const s = base.sample({ ...controls, cylinderBias: 0 }, t);
      const wear = clamp3(getHours() / 24, 0, 1);
      return {
        ...s,
        oilPressure: Number(clamp3(s.oilPressure - 12 * wear, 0, 40).toFixed(1)),
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
        vibOrder1: Number((s.vibOrder1 + 1.9 * wear).toFixed(2))
      };
    }
  };
}
function createEngineSimulator(seed = 42) {
  const random2 = mulberry32(seed);
  let soakC = 0;
  let lastT = null;
  return {
    sample({ rpm, map, altitude, ambientC, cylinderBias: bias }, t) {
      const ambientStressC = Math.max(0, ambientC - isaTemperatureC(altitude)) * 0.4;
      const stress = Math.max(0, (rpm - 4800) / 2400) + Math.max(0, map - 0.72) * 1.4;
      const dt = lastT === null ? 0 : clamp3(t - lastT, 0, 1);
      lastT = t;
      const excess = stress - SOAK_STRESS_THRESHOLD;
      soakC = excess > 0 ? Math.min(SOAK_MAX_C, soakC + SOAK_RATE_C_PER_S * excess * dt) : soakC * Math.exp(-dt / SOAK_RECOVERY_TAU_S);
      const resonance = 1.6 * Math.exp(-(((rpm - MOUNT_RESONANCE_RPM) / MOUNT_RESONANCE_WIDTH_RPM) ** 2));
      const instability = Math.max(0, bias - UNSTABLE_BIAS_ONSET) * 0.35 + Math.max(0, 0.5 - map) * 30;
      const oilPressure = Number(clamp3(31 - stress * 5.2 - bias * 0.12 + Math.sin(t * 3) * 0.25, 18, 34).toFixed(1));
      const vibration = Number((2.1 + stress * 1.8 + bias / 30 + resonance * 0.4 + Math.abs(Math.sin(t * 4)) * 0.45).toFixed(2));
      const fuelFlow = Number((18 + rpm / 620 + map * 9 + bias / 12 + Math.sin(t * 2) * 0.12).toFixed(2));
      const batteryVoltage = Number((27.7 + Math.sin(t * 1.8) * 0.18 - Math.max(0, vibration - 4) * 0.2).toFixed(2));
      const alternatorHealth = Math.round(clamp3(99 - Math.max(0, 28 - batteryVoltage) * 8 - Math.max(0, vibration - 4) * 4, 65, 100));
      const injectionTiming = Number((18.5 + Math.sin(t * 1.3) * 0.22 - bias / 140).toFixed(2));
      const oilTemp = Math.round(94 + stress * 13 + soakC * 0.6 + ambientStressC);
      const rpmStress = Math.max(0, (rpm - 4800) / 2400);
      const cht = [214, 216, 213, 215].map((v, i) => Math.round(v + bias * (i === 2 ? 0.8 : 0.03) + rpmStress * (i + 1) + soakC + ambientStressC));
      const egt = [808, 821, 836, 830].map((v, i) => {
        const scatter = (random2() * 2 - 1) * (i === 2 ? instability : instability * 0.15);
        return Math.round(v + rpmStress * (i + 2) * 5 + scatter + ambientStressC);
      });
      return {
        rpm,
        map,
        altitude,
        fuelFlow,
        injectionTiming,
        cht1: cht[0],
        cht2: cht[1],
        cht3: cht[2],
        cht4: cht[3],
        egt1: egt[0],
        egt2: egt[1],
        egt3: egt[2],
        egt4: egt[3],
        oilPressure,
        oilTemp,
        vibration,
        batteryVoltage,
        alternatorHealth,
        vibOrderHalf: Number((0.12 + Math.max(0, bias - UNSTABLE_BIAS_ONSET) / 60 + Math.abs(Math.sin(t * 1.1)) * 0.04).toFixed(2)),
        vibOrder1: Number((0.35 + 0.25 * stress + resonance + Math.abs(Math.sin(t * 1.7)) * 0.06).toFixed(2)),
        vibOrder2: Number((0.8 + 0.3 * stress + Math.abs(Math.sin(t * 2.3)) * 0.05).toFixed(2))
      };
    }
  };
}

// server/can-fd.ts
var CAN_FD_LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
var u16 = (name, scale, offset = 0) => ({ name, bytes: 2, scale, offset });
var tempSignal = (name) => u16(name, 10, -40);
var FRAME_SPECS = [
  {
    id: 419385573,
    name: "EEC_SPEED_LOAD",
    dlc: 12,
    signals: [u16("rpm", 4), u16("map", 1e3), u16("fuelFlow", 100), { name: "injectionTiming", bytes: 2, signed: true, scale: 100, offset: 0 }, u16("altitude", 2, -1e3)]
  },
  {
    id: 419385829,
    name: "CYL_TEMPS",
    dlc: 20,
    signals: ["cht1", "cht2", "cht3", "cht4", "egt1", "egt2", "egt3", "egt4"].map(tempSignal)
  },
  { id: 419386085, name: "LUBRICATION", dlc: 8, signals: [u16("oilPressure", 100), tempSignal("oilTemp")] },
  { id: 419386341, name: "VIBRATION", dlc: 12, signals: [u16("vibration", 100), u16("vibOrderHalf", 100), u16("vibOrder1", 100), u16("vibOrder2", 100)] },
  { id: 419386597, name: "ELECTRICAL", dlc: 8, signals: [u16("batteryVoltage", 100), { name: "alternatorHealth", bytes: 1, scale: 1, offset: 0 }] }
];
for (const spec of FRAME_SPECS) {
  const needed = 2 + spec.signals.reduce((n, s) => n + s.bytes, 0);
  if (!CAN_FD_LENGTHS.includes(spec.dlc) || spec.dlc < needed) {
    throw new Error(`CAN-FD frame ${spec.name} has invalid length ${spec.dlc} (needs \u2265 ${needed})`);
  }
}
function crc8J1850(bytes) {
  let crc = 255;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 128 ? (crc << 1 ^ 29) & 255 : crc << 1 & 255;
  }
  return crc ^ 255;
}
function frameCrc(id, data) {
  const idBytes = [id & 255, id >>> 8 & 255, id >>> 16 & 255, id >>> 24 & 255];
  return crc8J1850(idBytes.concat(Array.from(data.subarray(0, data.length - 1))));
}
function rawRange(signal) {
  const bits = signal.bytes * 8;
  return signal.signed ? [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1] : [0, 2 ** bits - 1];
}
var createEncoderState = () => ({ counters: /* @__PURE__ */ new Map() });
function encodeFrames(signals, state) {
  const saturated = [];
  const frames = FRAME_SPECS.map((spec) => {
    const data = new Uint8Array(spec.dlc).fill(255);
    const counter = (state.counters.get(spec.id) ?? -1) + 1 & 15;
    state.counters.set(spec.id, counter);
    data[0] = counter;
    let cursor = 1;
    for (const signal of spec.signals) {
      const value = signals[signal.name];
      if (!Number.isFinite(value)) throw new Error(`CAN-FD signal ${signal.name} is not finite`);
      const [min, max] = rawRange(signal);
      const unclamped = Math.round((value - signal.offset) * signal.scale);
      const raw = Math.max(min, Math.min(max, unclamped));
      if (raw !== unclamped) saturated.push(signal.name);
      const unsigned = raw < 0 ? raw + 2 ** (signal.bytes * 8) : raw;
      for (let b = 0; b < signal.bytes; b++) data[cursor + b] = unsigned >>> 8 * b & 255;
      cursor += signal.bytes;
    }
    data[spec.dlc - 1] = frameCrc(spec.id, data);
    return { id: spec.id, dlc: spec.dlc, data };
  });
  return { frames, saturated };
}
var createDecoderState = () => ({ lastCounter: /* @__PURE__ */ new Map(), decoded: 0, crcErrors: 0, counterErrors: 0 });
var CanFdIntegrityError = class extends Error {
};
function decodeFrames(frames, state) {
  const out = {};
  for (const frame of frames) {
    const spec = FRAME_SPECS.find((s) => s.id === frame.id);
    if (!spec) throw new CanFdIntegrityError(`Unknown CAN-FD frame 0x${frame.id.toString(16)}`);
    if (frame.dlc !== spec.dlc || frame.data.length !== spec.dlc) throw new CanFdIntegrityError(`${spec.name}: length ${frame.data.length} \u2260 ${spec.dlc}`);
    if (frame.data[spec.dlc - 1] !== frameCrc(frame.id, frame.data)) {
      state.crcErrors++;
      throw new CanFdIntegrityError(`${spec.name}: CRC mismatch`);
    }
    const counter = frame.data[0] & 15;
    const previous = state.lastCounter.get(frame.id);
    if (previous !== void 0 && counter !== (previous + 1 & 15)) state.counterErrors++;
    state.lastCounter.set(frame.id, counter);
    let cursor = 1;
    for (const signal of spec.signals) {
      let raw = 0;
      for (let b = 0; b < signal.bytes; b++) raw += frame.data[cursor + b] * 2 ** (8 * b);
      if (signal.signed && raw >= 2 ** (signal.bytes * 8 - 1)) raw -= 2 ** (signal.bytes * 8);
      const decimals = Math.max(0, Math.ceil(Math.log10(signal.scale)));
      out[signal.name] = Number((raw / signal.scale + signal.offset).toFixed(decimals));
      cursor += signal.bytes;
    }
    state.decoded++;
  }
  const missing = FRAME_SPECS.flatMap((s) => s.signals).filter((s) => out[s.name] === void 0);
  if (missing.length) throw new CanFdIntegrityError(`Missing CAN-FD signals: ${missing.map((s) => s.name).join(", ")}`);
  return out;
}

// server/fault-detection.ts
var FAULT_CONFIDENCE_THRESHOLD = 0.42;
var FAULT_HISTORY_LENGTH = 64;
var clamp4 = (n, min, max) => Math.max(min, Math.min(max, n));
var mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
var stdDev = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
};
function slope(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
var window = (history, sample, size) => [...history.slice(-(size - 1)), sample];
function instantaneousFaults(s) {
  const { vibration, fuelFlow, injectionTiming, oilPressure, oilTemp, t } = s;
  return [
    { type: "misfire", severity: vibration > 4.4 ? "HIGH" : "LOW", confidence: clamp4(vibration / 6, 0.12, 0.98), detail: `Vibration ${vibration} mm/s with unstable combustion residual` },
    { type: "injector abnormality", severity: fuelFlow > 31 || Math.abs(injectionTiming - 18.5) > 0.4 ? "MEDIUM" : "LOW", confidence: clamp4((fuelFlow - 20) / 18 + Math.abs(injectionTiming - 18.5), 0.1, 0.96), detail: `Fuel flow ${fuelFlow} L/h; injection timing ${injectionTiming}\xB0` },
    { type: "coking/lubrication issue", severity: oilPressure < 24 || oilPressure > 33 ? "HIGH" : "LOW", confidence: clamp4((32 - oilPressure) / 14, 0.1, 0.97), detail: `Oil pressure ${oilPressure} psi and oil temperature ${Math.round(oilTemp)} \xB0C` },
    { type: "sensor drift", severity: Math.abs(Math.sin(t / 9)) > 0.92 ? "MEDIUM" : "LOW", confidence: 0.22 + Math.abs(Math.sin(t / 9)) * 0.55, detail: "Cross-sensor residual disagreement monitor" }
  ];
}
var COMBUSTION_WINDOW = 20;
var COMBUSTION_MIN_SAMPLES = 10;
function detectCombustionInstability(sample, history) {
  const w = window(history, sample, COMBUSTION_WINDOW);
  if (w.length < COMBUSTION_MIN_SAMPLES) return null;
  const perCylinder = sample.egtResidual.map((_, cyl) => w.map((s) => s.egtResidual[cyl]));
  const sigmas = perCylinder.map(stdDev);
  const worst = sigmas.indexOf(Math.max(...sigmas));
  const sigma = sigmas[worst];
  const swing = Math.max(...perCylinder[worst]) - Math.min(...perCylinder[worst]);
  const severity = sigma > 5 ? "HIGH" : sigma > 3 ? "MEDIUM" : "LOW";
  return {
    type: "combustion instability",
    severity,
    confidence: clamp4((sigma - 1.5) / 5, 0.05, 0.97),
    detail: `EGT residual \u03C3 ${sigma.toFixed(1)} \xB0C on CYL ${worst + 1} over ${w.length} samples (${(sample.t - w[0].t).toFixed(1)} s); peak swing ${swing.toFixed(0)} \xB0C`
  };
}
var TREND_WINDOW = 40;
var TREND_MIN_SAMPLES = 20;
var TREND_MIN_SPAN_S = 2.5;
var CHT_SLOPE_FULL_SCALE = 20;
var OIL_SLOPE_FULL_SCALE = 10;
var LEVEL_FULL_SCALE = 30;
function detectOverheatingTrend(sample, history) {
  const w = window(history, sample, TREND_WINDOW);
  if (w.length < TREND_MIN_SAMPLES || sample.t - w[0].t < TREND_MIN_SPAN_S) return null;
  const ts = w.map((s) => s.t);
  const chtPerMin = slope(ts, w.map((s) => s.chtResidualMean)) * 60;
  const oilPerMin = slope(ts, w.map((s) => s.oilTempResidual)) * 60;
  const slopeScore = clamp4(Math.max(chtPerMin / CHT_SLOPE_FULL_SCALE, oilPerMin / OIL_SLOPE_FULL_SCALE), 0, 1);
  const levelScore = clamp4(sample.chtResidualMean / LEVEL_FULL_SCALE, 0, 1);
  const severity = chtPerMin > 15 || oilPerMin > 8 || levelScore >= 1 ? "HIGH" : chtPerMin > 6 || oilPerMin > 3 || levelScore > 0.5 ? "MEDIUM" : "LOW";
  const signed = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
  return {
    type: "overheating trend",
    severity,
    confidence: clamp4(Math.max(0.05 + 0.9 * slopeScore, 0.9 * levelScore), 0.05, 0.97),
    detail: `CHT ${signed(chtPerMin)} \xB0C/min, oil ${signed(oilPerMin)} \xB0C/min vs physics baseline (mean CHT residual ${signed(sample.chtResidualMean)} \xB0C)`
  };
}
var SENSOR_RANGES = {
  oilPressure: [5, 110],
  oilTemp: [-40, 200],
  fuelFlow: [0, 90],
  vibration: [0, 40]
};
var FLATLINE_WINDOW = 12;
function detectSensorFailure(sample, history) {
  const last = history.at(-1);
  const gap = last && sample.t - last.t;
  if (gap && gap > 1) return {
    type: "sensor failure",
    severity: "HIGH",
    confidence: 0.95,
    detail: `Dropout: telemetry gap ${gap.toFixed(1)} s; verify sensor bus and stale channels`
  };
  for (const [name, [min, max]] of Object.entries(SENSOR_RANGES)) {
    const value = sample[name];
    if (!Number.isFinite(value)) return {
      type: "sensor failure",
      severity: "HIGH",
      confidence: 0.99,
      detail: `Dropout: ${name} missing or non-finite; verify channel and wiring`
    };
    if (value < min || value > max) return {
      type: "sensor failure",
      severity: "HIGH",
      confidence: 0.95,
      detail: `Out-of-range: ${name} ${value} outside plausible sensor limits [${min}, ${max}]; cross-check independently`
    };
  }
  const recent = window(history, sample, FLATLINE_WINDOW);
  if (recent.length < FLATLINE_WINDOW || sample.t - recent[0].t < 1.5 || recent.some((s, i) => i > 0 && s.t - recent[i - 1].t > 1)) return null;
  const rpmSpan = Math.max(...recent.map((s) => s.rpm)) - Math.min(...recent.map((s) => s.rpm));
  if (rpmSpan < 100) return null;
  for (const name of Object.keys(SENSOR_RANGES)) {
    const values = recent.map((s) => s[name]);
    if (Math.max(...values) - Math.min(...values) < 1e-3) return {
      type: "sensor failure",
      severity: "MEDIUM",
      confidence: 0.9,
      detail: `Flatline: ${name} unchanged over ${recent.length} samples while RPM changed ${Math.round(rpmSpan)}; inspect sensor and wiring`
    };
  }
  return null;
}
var VIBRATION_WINDOW = 20;
var VIBRATION_MIN_SAMPLES = 8;
function detectAbnormalVibration(sample, history) {
  const w = window(history, sample, VIBRATION_WINDOW);
  if (w.length < VIBRATION_MIN_SAMPLES) return null;
  const ratios = w.map((s) => s.vibrationOrders.first / Math.max(0.05, s.vibrationOrders.second));
  const meanRatio = mean(ratios);
  const persistence = ratios.filter((r) => r > 1).length / ratios.length;
  const excess = clamp4((meanRatio - 0.8) / 1.2, 0, 1);
  const { half, first, second } = sample.vibrationOrders;
  const severity = meanRatio > 1.6 ? "HIGH" : meanRatio > 1.1 ? "MEDIUM" : "LOW";
  return {
    type: "abnormal vibration",
    severity,
    confidence: clamp4(0.05 + 0.6 * excess + 0.35 * persistence, 0.05, 0.97),
    detail: `1\xD7 order ${first.toFixed(2)} mm/s vs 2\xD7 firing order ${second.toFixed(2)} mm/s (ratio ${meanRatio.toFixed(2)}, ${Math.round(persistence * 100)}% of window) at ${Math.round(sample.rpm)} rpm; 0.5\xD7 ${half.toFixed(2)} mm/s`
  };
}

// server/ecu-interface.ts
function createSimulatedCanAdapter(engine2) {
  const encoder = createEncoderState();
  return { readCycle: (controls, tSeconds) => encodeFrames(engine2.sample(controls, tSeconds), encoder) };
}
var FAULT_BIT = {
  HEARTBEAT_STALE: 1 << 0,
  COMMAND_OUT_OF_RANGE: 1 << 1,
  TIMING_DRIFT: 1 << 2
};
function createEcuInterface() {
  let heartbeat = 0;
  let lastRpmTarget = 5203;
  return {
    step(controls, tSeconds) {
      heartbeat = (heartbeat + 1) % 65536;
      const rpmTarget = controls.rpm;
      const fuelSchedule = Number((18 + rpmTarget / 620 + controls.map * 9).toFixed(2));
      const ignitionTiming = Number((18.5 + Math.sin(tSeconds * 1.3) * 0.22).toFixed(2));
      let faultWord = 0;
      const rpmJump = Math.abs(rpmTarget - lastRpmTarget);
      if (rpmJump > 2500) faultWord |= FAULT_BIT.COMMAND_OUT_OF_RANGE;
      lastRpmTarget = rpmTarget;
      const linkState = faultWord === 0 ? "OK" : faultWord & FAULT_BIT.COMMAND_OUT_OF_RANGE ? "DEGRADED" : "LOST";
      return { rpmTarget, fuelSchedule, ignitionTiming, heartbeat, faultWord, linkState };
    }
  };
}

// server/onboard-pipeline.ts
var TICK_INTERVAL_MS = 150;
function createOnboardPipeline(engine2, canAdapter = createSimulatedCanAdapter(engine2), ecu = createEcuInterface()) {
  const decoder = createDecoderState();
  return {
    next(controls, nowMs = Date.now()) {
      const t = nowMs / 1e3;
      const ecuStatus = ecu.step(controls, t);
      const { frames, saturated } = canAdapter.readCycle(controls, t);
      const s = decodeFrames(frames, decoder);
      const physics = computeResiduals(
        { cht: [s.cht1, s.cht2, s.cht3, s.cht4], egt: [s.egt1, s.egt2, s.egt3, s.egt4], oilTemp: s.oilTemp },
        computeBaseline({ rpm: s.rpm, map: s.map, altitude: s.altitude, ambientC: controls.ambientC })
      );
      const sample = {
        t,
        rpm: s.rpm,
        fuelFlow: s.fuelFlow,
        injectionTiming: s.injectionTiming,
        vibration: s.vibration,
        vibrationOrders: { half: s.vibOrderHalf, first: s.vibOrder1, second: s.vibOrder2 },
        oilPressure: s.oilPressure,
        oilTemp: s.oilTemp,
        egtResidual: physics.residuals.egt,
        chtResidualMean: physics.residuals.cht.reduce((a, b) => a + b, 0) / 4,
        oilTempResidual: physics.residuals.oilTemp
      };
      return {
        ts: new Date(nowMs).toISOString(),
        signals: s,
        physics,
        sample,
        immediateFaults: instantaneousFaults(sample),
        ecu: ecuStatus,
        can: {
          bus: "CAN-FD",
          ecu: "AP04-ECU",
          frameRate: Math.round(1e3 / TICK_INTERVAL_MS * FRAME_SPECS.length),
          frames: decoder.decoded,
          framesPerCycle: FRAME_SPECS.length,
          crcErrors: decoder.crcErrors,
          counterErrors: decoder.counterErrors,
          saturatedSignals: saturated
        }
      };
    }
  };
}

// server/maintenance-advisory.ts
var components = {
  misfire: { component: "Combustion system", action: "Inspect ignition and cylinder combustion before release." },
  "injector abnormality": { component: "Fuel injection", action: "Check injector flow, timing and fuel delivery." },
  "coking/lubrication issue": { component: "Lubrication circuit", action: "Verify oil pressure independently; inspect filter and oil circuit." },
  "sensor drift": { component: "Sensor network", action: "Cross-check sensor calibration against an independent instrument." },
  "sensor failure": { component: "Sensor network", action: "Verify the affected channel and wiring before relying on predictions." },
  "combustion instability": { component: "Cylinder combustion", action: "Inspect the affected cylinder and ignition system." },
  "overheating trend": { component: "Cooling system", action: "Inspect cooling airflow, oil temperature and CHT trend." },
  "abnormal vibration": { component: "Rotating assembly", action: "Inspect mounts, rotating balance and vibration pickups." }
};
function recommendMaintenance(prediction, faults) {
  const unreliable = prediction.outOfRangeFeatures.length > 0 || faults.some((f) => f.type === "sensor failure");
  const modelHours = Math.max(0, Math.min(24, prediction.rul * 0.5));
  const advisories = faults.map((fault) => {
    const urgent = fault.severity === "HIGH" || fault.type === "sensor failure";
    const hoursToAction = urgent ? 0 : Math.min(modelHours, fault.severity === "MEDIUM" ? 2 : 8);
    return {
      component: components[fault.type].component,
      urgency: urgent || hoursToAction === 0 ? "IMMEDIATE" : hoursToAction <= 2 ? "SCHEDULE" : "MONITOR",
      hoursToAction,
      action: components[fault.type].action,
      evidence: `${fault.type} (${fault.severity.toLowerCase()}, confidence ${Math.round(fault.confidence * 100)}%); model RUL ${prediction.rul.toFixed(1)} h${unreliable ? "; estimate uncertain / verify sensors" : ""}.`
    };
  });
  if (advisories.length === 0) advisories.push({
    component: "Engine health",
    urgency: modelHours <= 2 ? "SCHEDULE" : "MONITOR",
    hoursToAction: modelHours,
    action: modelHours <= 2 ? "Schedule an engine inspection; verify the model estimate against independent measurements." : "Continue monitoring; inspect at the next scheduled service.",
    evidence: `Model health ${prediction.health}/100; RUL ${prediction.rul.toFixed(1)} h${unreliable ? "; outside validated sensor range" : ""}.`
  });
  return advisories.sort((a, b) => a.hoursToAction - b.hoursToAction);
}

// server/telemetry-pipeline.ts
var round3 = (n) => Number(n.toFixed(3));
function createGroundPipeline() {
  const history = [];
  return {
    process(input, edgeMode = false) {
      const { signals: s, physics, sample, can, ecu } = input;
      const prediction = predictTelemetry({
        rpm: s.rpm,
        manifold_pressure_bar: s.map,
        oil_temp_c: s.oilTemp,
        oil_press_bar: s.oilPressure / 14.5038,
        cht_cyl1: s.cht1,
        cht_cyl2: s.cht2,
        cht_cyl3_anomaly: s.cht3,
        cht_cyl4: s.cht4
      });
      const temporal = [detectCombustionInstability, detectOverheatingTrend, detectAbnormalVibration, detectSensorFailure].map((detect) => detect(sample, history)).filter((f) => f !== null);
      const faultCandidates = [...input.immediateFaults, ...temporal].map((f) => ({ ...f, confidence: round3(f.confidence) }));
      history.push(sample);
      if (history.length > FAULT_HISTORY_LENGTH) history.shift();
      const faults = faultCandidates.filter((f) => f.confidence > FAULT_CONFIDENCE_THRESHOLD);
      return {
        ts: input.ts,
        rpm: s.rpm,
        map: s.map,
        altitude: s.altitude,
        fuelFlow: s.fuelFlow,
        vibration: s.vibration,
        batteryVoltage: s.batteryVoltage,
        alternatorHealth: s.alternatorHealth,
        injectionTiming: s.injectionTiming,
        oilTemp: s.oilTemp,
        oilPressure: s.oilPressure,
        cht: [s.cht1, s.cht2, s.cht3, s.cht4],
        egt: [s.egt1, s.egt2, s.egt3, s.egt4],
        vibrationOrders: { half: s.vibOrderHalf, first: s.vibOrder1, second: s.vibOrder2 },
        ...prediction,
        physics,
        hybridAnomaly: round3(fuseAnomaly(prediction.anomaly, physics.residualScore)),
        edgeMode,
        faults,
        faultCandidates,
        advisories: recommendMaintenance(prediction, faults),
        can: { ...can, lastFrames: [] },
        ecu
      };
    }
  };
}
function createTelemetryPipeline(engine2) {
  const onboard = createOnboardPipeline(engine2);
  const ground = createGroundPipeline();
  return { next(controls, nowMs, edgeMode = false) {
    return ground.process(onboard.next(controls, nowMs), edgeMode);
  } };
}

// server/link-security.ts
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
var MAX_AGE_MS = 3e4;
function linkKey() {
  const key = process.env.AEROTWIN_LINK_KEY;
  if (!key || key.length < 32) throw new Error("AEROTWIN_LINK_KEY must be a random secret of at least 32 characters");
  return key;
}
function ensureLinkSchema(db2) {
  db2.exec("CREATE TABLE IF NOT EXISTS link_sequences (source TEXT PRIMARY KEY, sequence INTEGER NOT NULL, last_seen INTEGER NOT NULL)");
}
function verifyEnvelope(body, signature, key, db2, now = Date.now()) {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) throw new Error("Missing or invalid signature");
  const expected = createHmac("sha256", key).update(body).digest();
  if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) throw new Error("Invalid signature");
  const envelope = JSON.parse(body);
  if (!envelope || typeof envelope !== "object" || typeof envelope.source !== "string" || !/^[0-9a-f-]{36}$/.test(envelope.source) || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 || !Number.isFinite(envelope.sentAt) || Math.abs(now - envelope.sentAt) > MAX_AGE_MS || !envelope.payload || typeof envelope.payload !== "object" || !Number.isFinite(envelope.payload.signals?.rpm) || !Number.isFinite(envelope.payload.physics?.residualScore) || !Number.isFinite(envelope.payload.sample?.t) || !Array.isArray(envelope.payload.immediateFaults) || envelope.payload.immediateFaults.length > 16 || !Array.isArray(envelope.payload.physics?.residuals?.egt) || envelope.payload.physics.residuals.egt.length !== 4 || !Array.isArray(envelope.payload.physics?.residuals?.cht) || envelope.payload.physics.residuals.cht.length !== 4 || !Number.isFinite(Date.parse(envelope.payload.ts)) || Math.abs(now - Date.parse(envelope.payload.ts)) > MAX_AGE_MS) {
    throw new Error("Invalid or expired telemetry envelope");
  }
  const result = db2.prepare(`INSERT INTO link_sequences (source, sequence, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET sequence = excluded.sequence, last_seen = excluded.last_seen
    WHERE excluded.sequence > link_sequences.sequence`).run(envelope.source, envelope.sequence, now);
  if (result.changes !== 1) throw new Error("Replayed or out-of-order telemetry");
  return envelope;
}

// server/api-auth.ts
import { createHmac as createHmac2, createHash as createHash2, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
var tokenFor = (role) => process.env[role === "operator" ? "AEROTWIN_OPERATOR_TOKEN" : "AEROTWIN_MAINTENANCE_TOKEN"];
var hash = (value) => createHash2("sha256").update(value).digest();
var same = (a, b) => timingSafeEqual2(hash(a), hash(b));
var sessionKey = () => process.env.AEROTWIN_SESSION_KEY || process.env.AEROTWIN_LINK_KEY;
function authRequired() {
  return process.env.NODE_ENV === "production" || Boolean(tokenFor("operator") || tokenFor("maintenance"));
}
function validateAuthConfig() {
  if (!authRequired()) {
    console.warn("AeroTwin API auth is OFF: development-only mode; configure both role tokens to enable it.");
    return;
  }
  if (![tokenFor("operator"), tokenFor("maintenance"), sessionKey()].every((v) => v && v.length >= 32)) {
    throw new Error("Auth requires AEROTWIN_OPERATOR_TOKEN, AEROTWIN_MAINTENANCE_TOKEN and AEROTWIN_SESSION_KEY (each >=32 chars)");
  }
  if (same(tokenFor("operator"), tokenFor("maintenance"))) throw new Error("Role tokens must be distinct");
}
function roleFromToken(token) {
  if (tokenFor("operator") && same(token, tokenFor("operator"))) return "operator";
  if (tokenFor("maintenance") && same(token, tokenFor("maintenance"))) return "maintenance";
  return null;
}
function cookieRole(cookie) {
  const match = cookie?.match(/(?:^|;\s*)aerotwin_session=([^;]+)/);
  if (!match || !sessionKey()) return null;
  const [role, expires, mac] = match[1].split(".");
  if (role !== "operator" && role !== "maintenance" || !/^\d+$/.test(expires) || Number(expires) < Date.now() || !mac || !/^[0-9a-f]{64}$/.test(mac)) return null;
  const expected = createHmac2("sha256", sessionKey()).update(`${role}.${expires}`).digest("hex");
  return same(mac, expected) ? role : null;
}
function currentRole(req) {
  if (!authRequired()) return "operator";
  const authorization = req.get("Authorization");
  if (authorization?.startsWith("Bearer ")) return roleFromToken(authorization.slice(7));
  return cookieRole(req.get("Cookie"));
}
function createSession(req, res) {
  const authorization = req.get("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : req.body?.token;
  const role = typeof token === "string" ? roleFromToken(token) : null;
  if (!role) return res.status(401).json({ error: "Invalid token" });
  const expires = Date.now() + 8 * 60 * 60 * 1e3;
  const mac = createHmac2("sha256", sessionKey()).update(`${role}.${expires}`).digest("hex");
  res.set("Cache-Control", "no-store");
  res.cookie("aerotwin_session", `${role}.${expires}.${mac}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1e3,
    path: "/api"
  });
  return res.json({ role });
}
function apiAuth(req, res, next) {
  const role = currentRole(req);
  if (!role) return res.status(401).set("Cache-Control", "no-store").json({ error: "Authentication required" });
  const path2 = req.path;
  const maintenanceWrite = req.method === "POST" && path2 === "/faults";
  const operatorWrite = req.method !== "GET" && req.method !== "HEAD" && !maintenanceWrite;
  if (maintenanceWrite && role !== "maintenance" || operatorWrite && role !== "operator") {
    return res.status(403).json({ error: "Insufficient role" });
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !req.get("Authorization") && req.get("Origin")) {
    try {
      if (new URL(req.get("Origin")).host !== req.get("Host")) return res.status(403).json({ error: "Invalid origin" });
    } catch {
      return res.status(403).json({ error: "Invalid origin" });
    }
  }
  next();
}

// server/telemetry-controls.ts
function parseControls(query) {
  const limits = { rpm: [5203, 1e3, 7200], map: [0.84, 0.3, 1.84], altitude: [8200, 0, 16e3], cylinderBias: [18, 0, 80], ambientC: [15, -10, 50] };
  const result = {};
  for (const key of Object.keys(limits)) {
    const [fallback, min, max] = limits[key];
    const raw = query[key];
    if (raw !== void 0 && (typeof raw !== "string" || raw.trim() === "")) throw new Error(`Invalid ${key}: expected a single number.`);
    const value = raw === void 0 ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}: expected ${min}\u2013${max}.`);
    result[key] = value;
  }
  return result;
}

// server/population-grid.ts
var candidateZones = [
  { id: "L-01", name: "West open ground", lat: 12.9694, lng: 77.5738, densityScore: 9 },
  { id: "L-02", name: "North field", lat: 12.9931, lng: 77.5903, densityScore: 18 },
  { id: "L-03", name: "East greenbelt", lat: 12.9761, lng: 77.6159, densityScore: 22 },
  { id: "L-04", name: "South clearing", lat: 12.9478, lng: 77.594, densityScore: 24 },
  { id: "L-05", name: "Northwest edge", lat: 12.9854, lng: 77.5683, densityScore: 4 },
  { id: "L-06", name: "Market perimeter", lat: 12.9662, lng: 77.6034, densityScore: 74 },
  { id: "L-07", name: "Central corridor", lat: 12.9748, lng: 77.5981, densityScore: 92 },
  { id: "L-08", name: "Southwest reserve", lat: 12.9557, lng: 77.5763, densityScore: 14 }
];
function scoreLandingZones(currentLat, currentLng, safeRadiusM) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  return candidateZones.map((zone) => {
    const deltaLat = toRadians(zone.lat - currentLat);
    const deltaLng = toRadians(zone.lng - currentLng);
    const haversine = Math.sin(deltaLat / 2) ** 2 + Math.cos(toRadians(currentLat)) * Math.cos(toRadians(zone.lat)) * Math.sin(deltaLng / 2) ** 2;
    const distanceM = Math.round(2 * 6371e3 * Math.asin(Math.sqrt(haversine)));
    return { ...zone, distanceM };
  }).filter((zone) => zone.distanceM <= safeRadiusM).sort((a, b) => a.densityScore - b.densityScore || a.distanceM - b.distanceM);
}

// server/mission-data.ts
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
var LEGACY_ID = "UNASSIGNED";
function ensureMissionTelemetrySchema(db2) {
  const columns = db2.prepare("PRAGMA table_info(telemetry_history)").all();
  if (!columns.some((column) => column.name === "mission_id")) db2.exec("ALTER TABLE telemetry_history ADD COLUMN mission_id TEXT");
  db2.exec("CREATE INDEX IF NOT EXISTS telemetry_history_mission_id ON telemetry_history(mission_id, id)");
}
function listReplayRuns(db2) {
  const missions = db2.prepare(`SELECT m.id, m.mission, m.status, m.created_at, m.report_notes,
    CASE WHEN lower(m.mission) = 'endurance mission' THEN (SELECT COUNT(*) FROM endurance_samples s WHERE s.run_id = m.id)
    ELSE (SELECT COUNT(*) FROM telemetry_history t WHERE t.mission_id = m.id) END AS sample_count
    FROM missions m WHERE sample_count > 0 ORDER BY m.created_at DESC LIMIT 30`).all();
  const legacy = db2.prepare("SELECT COUNT(*) AS count, MIN(ts) AS first_ts FROM telemetry_history WHERE mission_id IS NULL").get();
  return [...missions, ...legacy.count ? [{ id: LEGACY_ID, mission: "Unassigned telemetry (legacy)", status: "RECORDED", created_at: legacy.first_ts, report_notes: "Stored before mission attribution was enabled", sample_count: legacy.count }] : []];
}
function readMissionSamples(db2, id, limit = 600) {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) return null;
  if (id === LEGACY_ID) return db2.prepare("SELECT id, ts, payload FROM (SELECT id, ts, payload FROM telemetry_history WHERE mission_id IS NULL ORDER BY id DESC LIMIT ?) ORDER BY id ASC").all(limit);
  const mission = db2.prepare("SELECT mission FROM missions WHERE id = ?").get(id);
  if (!mission) return null;
  if (mission.mission.toLowerCase() === "endurance mission") return db2.prepare("SELECT id, ts, equivalent_hours, payload FROM (SELECT id, ts, equivalent_hours, payload FROM endurance_samples WHERE run_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC").all(id, limit);
  return db2.prepare("SELECT id, ts, payload FROM (SELECT id, ts, payload FROM telemetry_history WHERE mission_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC").all(id, limit);
}
function estimatedEfficiency(sample) {
  const powerKw = 30 * Math.max(sample.rpm, 0) / 6e3 * Math.max(sample.map, 0);
  return { powerKw: Number(powerKw.toFixed(2)), sfc: powerKw > 0 ? Number((sample.fuelFlow * 740 / powerKw).toFixed(1)) : null };
}
function serializeReplaySamples(rows) {
  return rows.flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload);
      const actual = payload.egt?.[2];
      const baseline = payload.physics?.expected?.egt?.[2];
      if (!Number.isFinite(actual) || !Number.isFinite(baseline)) return [];
      return [{
        id: row.id,
        ts: row.ts,
        equivalentHours: row.equivalent_hours ?? null,
        actual,
        baseline,
        residual: Number((actual - baseline).toFixed(1)),
        health: payload.health,
        rul: payload.rul,
        rpm: payload.rpm,
        map: payload.map,
        fuelFlow: payload.fuelFlow,
        faults: payload.faults ?? [],
        advisories: payload.advisories ?? [],
        ...estimatedEfficiency(payload)
      }];
    } catch {
      return [];
    }
  });
}
async function createMissionReport(db2, id) {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) return null;
  const mission = db2.prepare("SELECT id, mission, status, created_at, report_notes FROM missions WHERE id = ?").get(id);
  if (!mission && id !== LEGACY_ID) return null;
  const samples = serializeReplaySamples(readMissionSamples(db2, id, 600) ?? []);
  if (!samples.length) return null;
  const faults = db2.prepare("SELECT type, severity, confidence, detail, ts FROM faults WHERE mission_id = ? ORDER BY id DESC LIMIT 20").all(id);
  const latest = samples[samples.length - 1];
  const advisories = latest.advisories;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let y = 798;
  const clean = (value) => String(value ?? "").normalize("NFKD").replace(/[^\x20-\x7E]/g, "-");
  const line = (text, size = 10, heading = false) => {
    if (y < 62) {
      page = pdf.addPage([595, 842]);
      y = 798;
    }
    const safe = clean(text);
    const width = 100;
    for (let i = 0; i < safe.length; i += width) {
      page.drawText(safe.slice(i, i + width), { x: 42, y, size, font: heading ? bold : font, color: heading ? rgb(0.13, 0.35, 0.28) : rgb(0.14, 0.2, 0.2) });
      y -= size + 6;
    }
  };
  line("AEROTWIN / MISSION HEALTH REPORT", 18, true);
  line(`Mission: ${mission?.mission ?? "Unassigned legacy telemetry"} (${id})`, 12, true);
  line(`Status: ${mission?.status ?? "RECORDED"} | Recorded: ${mission?.created_at ?? samples[0].ts}`);
  line(`Generated: ${(/* @__PURE__ */ new Date()).toISOString()} | ${samples.length} stored samples in report window`);
  y -= 12;
  line("HEALTH AND PROGNOSTICS", 12, true);
  line(`Health index: ${latest.health ?? "Unavailable"} / 100`);
  line(`Remaining useful life (model estimate): ${latest.rul ?? "Unavailable"} hours`);
  line(`Fuel flow: ${latest.fuelFlow} L/h | Estimated power: ${latest.powerKw} kW | Estimated SFC: ${latest.sfc ?? "Unavailable"} g/kWh`);
  line("SFC uses assumed 0.74 kg/L fuel density and 30 kW at 6000 RPM / 1 bar MAP; not measured shaft power.");
  y -= 12;
  line("PERSISTED FAULTS", 12, true);
  if (!faults.length) line("No faults recorded for this mission.");
  faults.forEach((fault) => line(`${fault.ts} | ${fault.severity} ${fault.type} (${Math.round(fault.confidence * 100)}%) - ${fault.detail}`));
  y -= 12;
  line("RECOMMENDATIONS", 12, true);
  if (!advisories.length && !faults.length) line("Continue monitoring; review the next mission trace for changes.");
  if (!advisories.length && faults.length) line("Inspect and validate the listed fault channels before the next sortie; prioritize HIGH severity events.");
  advisories.forEach((advisory) => line(`${advisory.urgency} / ${advisory.component}: ${advisory.action} (within ${advisory.hoursToAction} hours)`));
  if (mission?.report_notes) {
    y -= 12;
    line("MISSION NOTES", 12, true);
    line(mission.report_notes);
  }
  return pdf.save();
}

// server/scenarios.ts
var SCENARIOS = {
  "high-altitude": { name: "High Altitude", phases: [
    { rpm: 4600, map: 0.76, altitude: 8e3, ambientC: 4, cylinderBias: 0 },
    { rpm: 5300, map: 0.88, altitude: 12e3, ambientC: -4, cylinderBias: 0 },
    { rpm: 5900, map: 0.98, altitude: 15500, ambientC: -9, cylinderBias: 0 }
  ] },
  "endurance-mission": { name: "Endurance Mission", phases: [
    { rpm: 4600, map: 0.72, altitude: 6500, ambientC: 18, cylinderBias: 0 },
    { rpm: 5100, map: 0.84, altitude: 8200, ambientC: 20, cylinderBias: 0 },
    { rpm: 5600, map: 0.92, altitude: 9500, ambientC: 22, cylinderBias: 0 }
  ] },
  "hot-weather": { name: "Hot-Weather Operation", phases: [
    { rpm: 4200, map: 0.72, altitude: 1200, ambientC: 38, cylinderBias: 0 },
    { rpm: 5500, map: 0.94, altitude: 2600, ambientC: 44, cylinderBias: 0 },
    { rpm: 6200, map: 1.04, altitude: 3400, ambientC: 48, cylinderBias: 0 }
  ] },
  "rapid-throttle": { name: "Rapid Throttle Transition", phases: [
    { rpm: 3200, map: 0.48, altitude: 4e3, ambientC: 20, cylinderBias: 0 },
    { rpm: 7e3, map: 1.12, altitude: 4e3, ambientC: 20, cylinderBias: 0 },
    { rpm: 3500, map: 0.52, altitude: 4e3, ambientC: 20, cylinderBias: 0 }
  ] }
};
function scenarioControls(id, step, steps = 36) {
  const phases = SCENARIOS[id].phases;
  const segment = Math.min(phases.length - 2, Math.floor(step / (steps / (phases.length - 1))));
  const t = Math.min(1, (step - segment * steps / (phases.length - 1)) / (steps / (phases.length - 1)));
  return Object.fromEntries(Object.keys(phases[0]).map((key) => [key, Number((phases[segment][key] * (1 - t) + phases[segment + 1][key] * t).toFixed(2))]));
}

// server/index.ts
var DEFAULT_MISSION_ID = "RPL-042";
var __filename = fileURLToPath2(import.meta.url);
var __dirname = path.dirname(__filename);
var dbPath = process.env.AEROTWIN_DB_PATH || path.resolve(process.cwd(), "aerotwin.sqlite");
var db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS telemetry_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, mission TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, landing_mode TEXT NOT NULL, report_notes TEXT DEFAULT '');
  CREATE TABLE IF NOT EXISTS faults (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL, confidence REAL NOT NULL, detail TEXT NOT NULL, ts TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS endurance_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES missions(id), ts TEXT NOT NULL, equivalent_hours REAL NOT NULL, payload TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS endurance_samples_run_id ON endurance_samples(run_id, id);
`);
ensureMissionTelemetrySchema(db);
ensureLinkSchema(db);
var edgeGround = /* @__PURE__ */ new Map();
var latestEdge = null;
var latestEdgeAt = 0;
db.prepare("INSERT OR IGNORE INTO missions (id, mission, status, created_at, landing_mode, report_notes) VALUES (?, ?, ?, ?, ?, ?)").run(DEFAULT_MISSION_ID, "Live simulator telemetry", "ACTIVE", (/* @__PURE__ */ new Date()).toISOString(), "NOMINAL", "Continuous simulated telemetry");
db.prepare("UPDATE missions SET status = 'INTERRUPTED' WHERE mission = 'Endurance mission' AND status = 'ACTIVE'").run();
var clamp5 = (n, min, max) => Math.max(min, Math.min(max, n));
var escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
var validMissionId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(id);
var engine = createEngineSimulator();
var sharedPipeline = createTelemetryPipeline(engine);
var enduranceRuns = /* @__PURE__ */ new Map();
var FAULT_REPERSIST_MS = 6e4;
var lastFaultWrite = /* @__PURE__ */ new Map();
function persistFaults(missionId, faults, nowMs = Date.now()) {
  const insert = db.prepare("INSERT INTO faults (mission_id, type, severity, confidence, detail, ts) VALUES (?, ?, ?, ?, ?, ?)");
  for (const f of faults) {
    const key = `${missionId}:${f.type}`;
    const last = lastFaultWrite.get(key);
    if (last !== void 0 && nowMs - last < FAULT_REPERSIST_MS) continue;
    lastFaultWrite.set(key, nowMs);
    insert.run(missionId, f.type, f.severity, f.confidence, f.detail, new Date(nowMs).toISOString());
  }
}
var missionIdFrom = (query) => {
  const id = query.missionId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : DEFAULT_MISSION_ID;
};
function persistTelemetry(payload, missionId) {
  const { faultCandidates: _candidates, can: { lastFrames: _frames, ...can }, ...rest } = payload;
  db.prepare("INSERT INTO telemetry_history (ts, payload, mission_id) VALUES (?, ?, ?)").run(payload.ts, JSON.stringify({ ...rest, can }), missionId);
}
async function startServer() {
  validateAuthConfig();
  if (process.env.NODE_ENV === "production") linkKey();
  initializeModel();
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=63072000");
    next();
  });
  const server = createServer(app);
  app.post("/internal/telemetry", express.text({ type: "application/json", limit: "32kb" }), (req, res) => {
    try {
      if (typeof req.body !== "string") return res.status(400).json({ error: "JSON body required" });
      const { source, payload } = verifyEnvelope(req.body, req.get("X-Telemetry-Signature"), linkKey(), db);
      if (!edgeGround.has(source)) edgeGround.set(source, createGroundPipeline());
      latestEdge = edgeGround.get(source).process(payload, true);
      latestEdgeAt = Date.now();
      persistTelemetry(latestEdge, DEFAULT_MISSION_ID);
      persistFaults(DEFAULT_MISSION_ID, latestEdge.faults);
      res.status(202).json({ accepted: true });
    } catch (error) {
      res.status(401).json({ error: error instanceof Error ? error.message : "Invalid telemetry" });
    }
  });
  app.use(express.json({ limit: "32kb" }));
  const staticPath = process.env.NODE_ENV === "production" ? path.resolve(__dirname, "public") : path.resolve(__dirname, "..", "dist", "public");
  app.get("/api/health", (_req, res) => res.json({ ok: true, database: "sqlite" }));
  app.get("/api/auth/status", (req, res) => res.set("Cache-Control", "no-store").json({ required: authRequired(), role: currentRole(req) }));
  app.post("/api/auth/session", createSession);
  app.post("/api/auth/logout", (_req, res) => res.clearCookie("aerotwin_session", { path: "/api" }).json({ ok: true }));
  app.use("/api", apiAuth);
  app.get("/api/landing-zones", (_req, res) => {
    res.set("Cache-Control", "no-store").json(scoreLandingZones(12.9716, 77.5946, 5e3));
  });
  app.get("/api/model/metrics", (_req, res) => res.set("Cache-Control", "no-store").json(getModelMetrics()));
  app.get("/api/endurance/runs", (_req, res) => res.set("Cache-Control", "no-store").json(db.prepare("SELECT id, mission, status, created_at, report_notes FROM missions WHERE mission = 'Endurance mission' ORDER BY created_at DESC LIMIT 8").all()));
  app.post("/api/endurance/runs", (req, res) => {
    try {
      const input = req.body || {};
      if (typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid flight controls.");
      const controls = parseControls(Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === "number" && Number.isFinite(value) ? String(value) : value])));
      const id = `END-${randomUUID2()}`;
      const startedAtMs = Date.now();
      const run = { id, startedAtMs, controls: { ...controls, cylinderBias: 0 }, hours: 0 };
      run.pipeline = createTelemetryPipeline(createEnduranceEngineSimulator(() => run.hours));
      db.prepare("INSERT INTO missions (id, mission, status, created_at, landing_mode, report_notes) VALUES (?, ?, ?, ?, ?, ?)").run(id, "Endurance mission", "ACTIVE", new Date(startedAtMs).toISOString(), "NOMINAL", "Accelerated time-based wear; cylinder bias isolated from mission");
      enduranceRuns.set(id, run);
      res.status(201).set("Cache-Control", "no-store").json({ id });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid flight controls" });
    }
  });
  app.post("/api/endurance/runs/:id/stop", (req, res) => {
    const run = enduranceRuns.get(req.params.id);
    if (!run) return res.status(404).json({ error: "Active endurance run not found" });
    const hours = enduranceHours(run.startedAtMs, Date.now());
    db.prepare("UPDATE missions SET status = 'COMPLETED', report_notes = ? WHERE id = ?").run(`Accelerated time-based wear; ${hours.toFixed(2)} equivalent flight hours`, run.id);
    enduranceRuns.delete(run.id);
    res.json({ id: run.id, equivalentHours: hours });
  });
  app.get("/api/endurance/runs/:id/samples", (req, res) => {
    if (!/^END-[0-9a-f-]{36}$/.test(req.params.id)) return res.status(400).json({ error: "Invalid run id" });
    res.set("Cache-Control", "no-store").json(db.prepare("SELECT ts, equivalent_hours, payload FROM endurance_samples WHERE run_id = ? ORDER BY id DESC LIMIT 300").all(req.params.id));
  });
  app.use(["/api/telemetry", "/api/telemetry/stream"], (req, res, next) => {
    try {
      res.locals.controls = parseControls(req.query);
      next();
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid telemetry controls" });
    }
  });
  app.get("/api/telemetry", (req, res) => {
    if (req.query.edgeMode === "true") {
      if (!latestEdge || Date.now() - latestEdgeAt > 5e3) return res.status(503).json({ error: "Onboard telemetry unavailable or stale" });
      return res.set("Cache-Control", "no-store").json(latestEdge);
    }
    const payload = sharedPipeline.next(res.locals.controls);
    persistTelemetry(payload, missionIdFrom(req.query));
    persistFaults(missionIdFrom(req.query), payload.faults);
    res.set("Cache-Control", "no-store").json(payload);
  });
  app.get("/api/telemetry/stream", (req, res) => {
    const runId = req.query.enduranceId;
    const run = typeof runId === "string" ? enduranceRuns.get(runId) : void 0;
    if (runId !== void 0 && !run) return res.status(404).json({ error: "Active endurance run not found" });
    if (req.query.edgeMode === "true" && run) return res.status(400).json({ error: "Edge mode is not available for endurance runs" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const pipeline = run?.pipeline ?? createTelemetryPipeline(engine);
    const missionId = run?.id ?? missionIdFrom(req.query);
    const edgeMode = req.query.edgeMode === "true";
    let lastEdgeAt = 0;
    const send = () => {
      if (run && !enduranceRuns.has(run.id)) {
        res.end();
        return;
      }
      if (edgeMode) {
        if (latestEdge && latestEdgeAt !== lastEdgeAt && Date.now() - latestEdgeAt <= 5e3) {
          lastEdgeAt = latestEdgeAt;
          res.write(`data: ${JSON.stringify(latestEdge)}

`);
        }
        return;
      }
      try {
        const nowMs = Date.now();
        if (run) run.hours = enduranceHours(run.startedAtMs, nowMs);
        const payload = pipeline.next(run?.controls ?? res.locals.controls, nowMs, edgeMode);
        if (run) {
          const endurance = { id: run.id, equivalentHours: Number(run.hours.toFixed(2)) };
          const { can: { lastFrames: _frames, ...can }, faultCandidates: _candidates, ...rest } = payload;
          db.prepare("INSERT INTO endurance_samples (run_id, ts, equivalent_hours, payload) VALUES (?, ?, ?, ?)").run(run.id, payload.ts, run.hours, JSON.stringify({ ...rest, can, endurance }));
          persistFaults(run.id, payload.faults, nowMs);
          res.write(`data: ${JSON.stringify({ ...payload, endurance })}

`);
        } else {
          persistTelemetry(payload, missionId);
          persistFaults(missionId, payload.faults, nowMs);
          res.write(`data: ${JSON.stringify(payload)}

`);
        }
      } catch (error) {
        console.error("Telemetry tick failed:", error);
      }
    };
    send();
    const timer = setInterval(send, TICK_INTERVAL_MS);
    req.on("close", () => clearInterval(timer));
  });
  app.get("/api/replay/runs", (_req, res) => res.set("Cache-Control", "no-store").json(listReplayRuns(db)));
  app.get("/api/replay/runs/:id", (req, res) => {
    const rows = readMissionSamples(db, req.params.id);
    if (!rows) return res.status(404).json({ error: "Mission not found" });
    res.set("Cache-Control", "no-store").json({ id: req.params.id, samples: serializeReplaySamples(rows) });
  });
  app.post("/api/scenarios/:id", (req, res) => {
    if (!Object.hasOwn(SCENARIOS, req.params.id)) return res.status(404).json({ error: "Unknown scenario" });
    const scenarioId = req.params.id;
    const scenario = SCENARIOS[scenarioId];
    const id = `SCN-${randomUUID2()}`;
    const started = Date.now();
    const pipeline = createTelemetryPipeline(scenarioId === "endurance-mission" ? createEnduranceEngineSimulator(() => currentHours) : createEngineSimulator());
    let currentHours = 0;
    const steps = 36;
    const samples = [];
    db.prepare("INSERT INTO missions (id, mission, status, created_at, landing_mode, report_notes) VALUES (?, ?, ?, ?, ?, ?)").run(id, scenario.name, "ACTIVE", new Date(started).toISOString(), "NOMINAL", "Scripted simulated scenario; accelerated profile, not a flown mission");
    try {
      for (let step = 0; step < steps; step++) {
        const controls = scenarioControls(scenarioId, step, steps - 1);
        currentHours = scenarioId === "endurance-mission" ? step * 24 / (steps - 1) : 0;
        const payload = pipeline.next(controls, started + step * TICK_INTERVAL_MS);
        if (scenarioId === "endurance-mission") {
          const { can: { lastFrames: _frames, ...can }, faultCandidates: _candidates, ...rest } = payload;
          db.prepare("INSERT INTO endurance_samples (run_id, ts, equivalent_hours, payload) VALUES (?, ?, ?, ?)").run(id, payload.ts, currentHours, JSON.stringify({ ...rest, can }));
        } else persistTelemetry(payload, id);
        persistFaults(id, payload.faults, started + step * TICK_INTERVAL_MS);
        samples.push(payload);
      }
      db.prepare("UPDATE missions SET status = 'COMPLETED' WHERE id = ?").run(id);
      res.status(201).set("Cache-Control", "no-store").json({ id, name: scenario.name, controls: scenarioControls(scenarioId, steps - 1, steps - 1), sampleCount: samples.length });
    } catch (error) {
      db.prepare("UPDATE missions SET status = 'INTERRUPTED' WHERE id = ?").run(id);
      res.status(500).json({ error: "Scenario simulation failed" });
    }
  });
  app.get("/api/telemetry/history", (req, res) => {
    const limit = clamp5(Number(req.query.limit || 100), 1, 1e3);
    res.json(db.prepare("SELECT id, ts, payload FROM telemetry_history ORDER BY id DESC LIMIT ?").all(limit));
  });
  app.post("/api/missions", (req, res) => {
    const body = req.body || {};
    const id = body.id || `MSN-${Date.now()}`;
    if (!validMissionId(id) || [body.mission, body.status, body.landingMode, body.reportNotes].some((v) => v !== void 0 && (typeof v !== "string" || v.length > 500))) return res.status(400).json({ error: "Invalid mission fields" });
    db.prepare("INSERT OR REPLACE INTO missions (id, mission, status, created_at, landing_mode, report_notes) VALUES (?, ?, ?, ?, ?, ?)").run(id, body.mission || "TAPAS patrol", body.status || "ACTIVE", (/* @__PURE__ */ new Date()).toISOString(), body.landingMode || "NOMINAL", body.reportNotes || "");
    res.status(201).json({ id });
  });
  app.get("/api/missions", (_req, res) => res.json(db.prepare("SELECT * FROM missions ORDER BY created_at DESC").all()));
  app.patch("/api/missions/:id/decision", (req, res) => {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(req.params.id)) return res.status(400).json({ error: "Invalid mission id" });
    if (!["RTB", "EMERGENCY LANDING"].includes(req.body?.status) || typeof req.body?.landingMode !== "string" || req.body.landingMode.length > 120) return res.status(400).json({ error: "Invalid decision" });
    const updated = db.prepare("UPDATE missions SET status = ?, landing_mode = ? WHERE id = ?").run(req.body.status, req.body.landingMode, req.params.id);
    if (!updated.changes) return res.status(404).json({ error: "Mission not found" });
    res.json({ id: req.params.id });
  });
  app.post("/api/faults", (req, res) => {
    const b = req.body || {};
    if (!validMissionId(b.missionId || DEFAULT_MISSION_ID) || [b.type, b.detail].some((v) => v !== void 0 && (typeof v !== "string" || v.length > 500)) || b.severity !== void 0 && !["LOW", "MEDIUM", "HIGH"].includes(b.severity) || b.confidence !== void 0 && (typeof b.confidence !== "number" || !Number.isFinite(b.confidence) || b.confidence < 0 || b.confidence > 1)) return res.status(400).json({ error: "Invalid fault fields" });
    db.prepare("INSERT INTO faults (mission_id, type, severity, confidence, detail, ts) VALUES (?, ?, ?, ?, ?, ?)").run(b.missionId || DEFAULT_MISSION_ID, b.type || "sensor drift", b.severity || "MEDIUM", b.confidence ?? 0.5, b.detail || "Maintenance recorded fault", (/* @__PURE__ */ new Date()).toISOString());
    res.status(201).json({ ok: true });
  });
  app.get("/api/faults", (req, res) => res.json(db.prepare("SELECT * FROM faults WHERE mission_id = ? ORDER BY id DESC LIMIT 100").all(String(req.query.missionId || DEFAULT_MISSION_ID))));
  app.get("/api/can/status", (_req, res) => res.json({
    bus: "CAN-FD",
    bitrate: "2 Mbps",
    ecu: "AP04-ECU",
    status: "ONLINE",
    framesPerSecond: Math.round(1e3 / TICK_INTERVAL_MS * FRAME_SPECS.length),
    frames: FRAME_SPECS.map((f) => ({ id: `0x${f.id.toString(16).toUpperCase()}`, name: f.name, dlc: f.dlc, signals: f.signals.map((sig) => sig.name) }))
  }));
  app.use("/api/reports/:missionId", (req, res, next) => validMissionId(req.params.missionId) ? next() : res.status(400).json({ error: "Invalid mission id" }));
  app.get("/api/reports/:missionId", async (req, res) => {
    try {
      const pdf = await createMissionReport(db, req.params.missionId);
      if (!pdf) return res.status(404).json({ error: "Mission or stored telemetry not found" });
      res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="aerotwin-${req.params.missionId}.pdf"`, "Cache-Control": "no-store" }).send(Buffer.from(pdf));
    } catch (error) {
      console.error("Report generation failed:", error);
      res.status(500).json({ error: "Report generation failed" });
    }
  });
  app.get("/api/reports/:missionId/print", (req, res) => {
    const mission = db.prepare("SELECT * FROM missions WHERE id = ?").get(req.params.missionId);
    const faults = db.prepare("SELECT * FROM faults WHERE mission_id = ? ORDER BY id DESC LIMIT 20").all(req.params.missionId);
    const latest = db.prepare("SELECT payload FROM telemetry_history ORDER BY id DESC LIMIT 1").get();
    const telemetry = latest ? JSON.parse(latest.payload) : sharedPipeline.next(parseControls({}));
    res.type("html").send(`<!doctype html><title>AeroTwin Health Report ${req.params.missionId}</title><style>body{font:14px Arial;color:#182522;max-width:900px;margin:40px auto}h1{color:#1b5144;border-bottom:3px solid #b9f49a;padding-bottom:12px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{border:1px solid #ccd9d3;border-radius:8px;padding:14px}.muted{color:#5b7169}table{width:100%;border-collapse:collapse;margin-top:20px}td,th{padding:9px;border-bottom:1px solid #dbe5df;text-align:left}@media print{button{display:none}}</style><button onclick="window.print()">Print / Save as PDF</button><h1>AeroTwin Mission Health Report \u2014 ${req.params.missionId}</h1><p class="muted">Generated ${(/* @__PURE__ */ new Date()).toISOString()} \xB7 persisted SQLite telemetry history \xB7 CAN-FD gateway</p><h2>${escapeHtml(mission?.mission || "Mission health snapshot")}</h2><div class="grid">${["Fuel flow", `${telemetry.fuelFlow} L/h`, "Vibration", `${telemetry.vibration} mm/s`, "Battery / alternator", `${telemetry.batteryVoltage} V / ${telemetry.alternatorHealth}%`, "Injection timing", `${telemetry.injectionTiming}\xB0`].map((x) => `<div class="card"><b>${escapeHtml(x)}</b></div>`).join("")}</div><h2>Detected fault types</h2><table><tr><th>Type</th><th>Severity</th><th>Confidence</th><th>Detail</th></tr>${faults.map((f) => `<tr><td>${escapeHtml(f.type)}</td><td>${escapeHtml(f.severity)}</td><td>${Math.round(f.confidence * 100)}%</td><td>${escapeHtml(f.detail)}</td></tr>`).join("") || `<tr><td colspan="4">No persisted faults for this mission.</td></tr>`}</table><h2>Landing decision</h2><p>${mission?.landing_mode || "RTB / emergency landing logic"}: safe-radius and least-populated-area selection is shown in the mission planner.</p>`);
  });
  app.use(express.static(staticPath));
  app.get("*", (_req, res) => res.sendFile(path.join(staticPath, "index.html")));
  const isProd = process.env.NODE_ENV === "production";
  const port = Number(process.env.PORT || process.env.API_PORT || (isProd ? 3e3 : 3001));
  server.listen(
    port,
    "0.0.0.0",
    () => console.log(`Server running on http://localhost:${port}/ with SQLite persistence${isProd ? "" : " (dev API \u2014 Vite proxies /api here)"}`)
  );
}
startServer().catch((err) => {
  console.error("Failed to start AeroTwin server:", err);
  if (String(err?.message || err).includes("sqlite")) {
    console.error(
      "node:sqlite requires Node.js 22.5+ (23.4+ recommended, no flag needed). Check `node -v` and upgrade if this is the cause."
    );
  }
  process.exit(1);
});
