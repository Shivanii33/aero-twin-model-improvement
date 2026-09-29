import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { RandomForestRegression } from "ml-random-forest";
import { FEATURE_NAMES, type ModelInput, type ModelMetrics, type ModelPrediction, type RegressionMetrics } from "../shared/model";

type DatasetRow = ModelInput & { timestamp_sec: number; target_health_index: number; target_rul_hours: number };
const SEED = 42;
const TRAIN_FRACTION = 0.8;
const PARAMETERS = { nEstimators: 64, maxFeatures: 6, maxDepth: 12, minNumSamples: 3 };
const VERSION = "TAPAS-RF-TREND-2.0";
const CONFIDENCE_METHOD = "Heuristic reliability score, not a calibrated probability: 100 × exp(−2 × (health tree standard deviation + RUL tree standard deviation / training RUL range + normalized range exceedance)). Capped at 50% for any out-of-range feature and 99% otherwise. Forest spread does not capture extrapolation uncertainty.";
type EdgeTrend = { anchorTemp: number; health: number; rul: number; healthSlope: number; rulSlope: number };
let trained: { health: RandomForestRegression; rul: RandomForestRegression; metrics: ModelMetrics; rulRange: number; trend: EdgeTrend; medians: number[] } | undefined;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
function fitSlope(rows: DatasetRow[], target: "target_health_index" | "target_rul_hours") {
  const xMean = rows.reduce((sum, row) => sum + row.oil_temp_c, 0) / rows.length;
  const yMean = rows.reduce((sum, row) => sum + row[target], 0) / rows.length;
  const covariance = rows.reduce((sum, row) => sum + (row.oil_temp_c - xMean) * (row[target] - yMean), 0);
  const variance = rows.reduce((sum, row) => sum + (row.oil_temp_c - xMean) ** 2, 0);
  return Math.min(0, variance ? covariance / variance : 0);
}
export function fitEdgeTrend(train: DatasetRow[]): EdgeTrend {
  const tail = train.slice(-Math.max(10, Math.floor(train.length / 8)));
  const anchor = train.slice(-Math.max(5, Math.floor(train.length / 40)));
  const average = (key: "oil_temp_c" | "target_health_index" | "target_rul_hours") => anchor.reduce((sum, row) => sum + row[key], 0) / anchor.length;
  return { anchorTemp: average("oil_temp_c"), health: average("target_health_index"), rul: average("target_rul_hours"),
    healthSlope: fitSlope(tail, "target_health_index"), rulSlope: fitSlope(tail, "target_rul_hours") };
}
export function applyEdgeTrend(health: number, rul: number, oilTemp: number, trend: EdgeTrend) {
  if (oilTemp <= trend.anchorTemp) return { health: clamp(health, 0, 1), rul: Math.max(0, rul) };
  const excess = oilTemp - trend.anchorTemp;
  return { health: clamp(Math.min(health, trend.health + excess * trend.healthSlope), 0, 1),
    rul: Math.max(0, Math.min(rul, trend.rul + excess * trend.rulSlope)) };
}

function random(seed: number) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(1664525, value) + 1013904223) >>> 0; return value / 4294967296; };
}
export function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  const next = random(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function scoreRegression(actual: number[], predicted: number[], unit: string): RegressionMetrics {
  if (!actual.length || actual.length !== predicted.length || [...actual, ...predicted].some(v => !Number.isFinite(v))) {
    throw new Error("Regression metrics require equally sized, finite, nonempty arrays.");
  }
  const mean = actual.reduce((sum, value) => sum + value, 0) / actual.length;
  const squaredError = actual.reduce((sum, value, i) => sum + (value - predicted[i]) ** 2, 0);
  const totalVariance = actual.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return {
    mae: actual.reduce((sum, value, i) => sum + Math.abs(value - predicted[i]), 0) / actual.length,
    rmse: Math.sqrt(squaredError / actual.length),
    r2: totalVariance === 0 ? null : 1 - squaredError / totalVariance,
    unit,
  };
}
const vector = (row: ModelInput) => FEATURE_NAMES.map(name => row[name]);

/**
 * Chronological holdout: sort by timestamp, train on the earliest `trainFraction`
 * of rows and test on the remaining later segment, so no future sample leaks into
 * training through correlated neighbours.
 */
export function timeOrderedSplit<T extends { timestamp_sec: number }>(rows: readonly T[], trainFraction: number) {
  const ordered = [...rows].sort((a, b) => a.timestamp_sec - b.timestamp_sec);
  const trainCount = Math.floor(ordered.length * trainFraction);
  return { train: ordered.slice(0, trainCount), test: ordered.slice(trainCount) };
}

export function initializeModel() {
  if (trained) return trained.metrics;
  const started = performance.now();
  // Both server/model.ts and the bundled dist/index.js resolve the dataset at the project root.
  const datasetPath = fileURLToPath(new URL("../tapas_extended_ml_dataset.csv", import.meta.url));
  const csv = readFileSync(datasetPath, "utf8");
  const parsed = Papa.parse<DatasetRow>(csv, { header: true, dynamicTyping: true, skipEmptyLines: "greedy" });
  const columns = [...FEATURE_NAMES, "timestamp_sec", "target_health_index", "target_rul_hours"] as const;
  if (parsed.errors.length || columns.some(name => !parsed.meta.fields?.includes(name))) {
    throw new Error(`Invalid TAPAS CSV: ${parsed.errors[0]?.message ?? "missing required columns"}`);
  }
  if (parsed.data.length < 10) throw new Error("TAPAS dataset needs at least 10 valid rows.");
  parsed.data.forEach((row, index) => {
    if (columns.some(name => typeof row[name] !== "number" || !Number.isFinite(row[name])) ||
      row.target_health_index < 0 || row.target_health_index > 1 || row.target_rul_hours < 0) {
      throw new Error(`Invalid numeric data or target at CSV row ${index + 2}`);
    }
  });
  const rows = parsed.data;
  const { train, test } = timeOrderedSplit(rows, TRAIN_FRACTION);
  const trainX = train.map(vector);
  const testX = test.map(vector);
  const options = { seed: SEED, nEstimators: PARAMETERS.nEstimators, maxFeatures: PARAMETERS.maxFeatures,
    replacement: false, useSampleBagging: true, noOOB: true, selectionMethod: "mean" as const,
    treeOptions: { maxDepth: PARAMETERS.maxDepth, minNumSamples: PARAMETERS.minNumSamples } };
  const health = new RandomForestRegression(options);
  const rul = new RandomForestRegression({ ...options, seed: SEED + 1 });
  health.train(trainX, train.map(row => row.target_health_index));
  rul.train(trainX, train.map(row => row.target_rul_hours));
  const actualHealth = test.map(row => row.target_health_index);
  const actualRul = test.map(row => row.target_rul_hours);
  const trend = fitEdgeTrend(train);
  const predictBatch = (xs: number[][]) => {
    const h = health.predict(xs), r = rul.predict(xs);
    return xs.map((x, i) => applyEdgeTrend(h[i], r[i], x[2], trend));
  };
  const baselineTargets = { health: scoreRegression(actualHealth, health.predict(testX), "health index (0–1)"),
    rul: scoreRegression(actualRul, rul.predict(testX), "hours") };
  const corrected = predictBatch(testX);
  const targets = { health: scoreRegression(actualHealth, corrected.map(value => value.health), "health index (0–1)"),
    rul: scoreRegression(actualRul, corrected.map(value => value.rul), "hours") };
  const featureImportance = FEATURE_NAMES.map((feature, column) => {
    let healthDelta = 0, rulDelta = 0;
    for (let repeat = 0; repeat < 3; repeat++) {
      const permuted = shuffled(testX.map(row => row[column]), SEED + column * 10 + repeat);
      const x = testX.map((row, i) => row.map((value, j) => j === column ? permuted[i] : value));
      const predictions = predictBatch(x);
      healthDelta += scoreRegression(actualHealth, predictions.map(value => value.health), "").mae - targets.health.mae;
      rulDelta += scoreRegression(actualRul, predictions.map(value => value.rul), "").mae - targets.rul.mae;
    }
    return { feature, health: healthDelta / 3, rul: rulDelta / 3 };
  });
  const features = FEATURE_NAMES.map(name => ({ name, min: Math.min(...train.map(row => row[name])), max: Math.max(...train.map(row => row[name])) }));
  const metrics: ModelMetrics = {
    model: "Random Forest Regression", version: VERSION, trainedAt: new Date().toISOString(),
    trainingMs: Math.round(performance.now() - started),
    dataset: { file: "tapas_extended_ml_dataset.csv", sha256: createHash("sha256").update(csv).digest("hex"), rows: rows.length, trainRows: train.length, testRows: test.length },
    split: {
      method: "Time-based holdout: earliest 80% of rows train, latest 20% test",
      seed: SEED, trainFraction: TRAIN_FRACTION,
      trainTimestampSec: [train[0].timestamp_sec, train[train.length - 1].timestamp_sec],
      testTimestampSec: [test[0].timestamp_sec, test[test.length - 1].timestamp_sec],
    },
    parameters: PARAMETERS, features, targets, baselineTargets,
    degradationMethod: `Training-only oil-temperature edge trend: least-squares nonpositive health and RUL slopes over the last ${Math.max(10, Math.floor(train.length / 8))} training rows, anchored to the mean of the last ${Math.max(5, Math.floor(train.length / 40))} training rows at ${trend.anchorTemp.toFixed(2)} °C. Beyond the anchor, take the lower of the forest estimate and the extrapolated estimate, then clamp to physical bounds. No timestamp or holdout targets enter inference.`,
    featureImportance,
    importanceMethod: "Held-out permutation importance for the combined predictor: mean increase in MAE over 3 seeded permutations per feature. Diagnostic only; never used to select or tune this model. Raw signed deltas; correlated features can share importance.",
    confidenceMethod: CONFIDENCE_METHOD,
    limitations: [
      "Evaluation is a chronological holdout: the test set is the final 20% of one time-series CSV, i.e. a future segment never seen in training. It is still a single run, not independent-flight validation.",
      "Late-life health (0–0.56) and RUL (0–4.8 h) lie below training targets. The forest cannot extrapolate; a train-only oil-temperature tail slope provides bounded degradation estimates instead. The oil-temperature proxy may fail with different operating regimes, sensor faults or independent flights.",
      "Compared with the previous random-row split (health MAE ≈ 0.001, R² ≈ 0.9999), those near-perfect scores came from interpolating between adjacent correlated samples and overstated forecasting ability.",
      "timestamp_sec and both targets are excluded from inputs. The holdout is never used for fitting or tuning.",
      "Current simulator RPM and cylinder temperatures may exceed training ranges. Forests cannot reliably extrapolate; confidence is reduced and affected features are flagged.",
      "Confidence is an ensemble-spread heuristic, not a probability of safety. This demo is not validated for flight or maintenance decisions.",
    ],
  };
  const trainRul = train.map(row => row.target_rul_hours);
  const medians = FEATURE_NAMES.map((_, column) => [...trainX.map(x => x[column])].sort((a, b) => a - b)[Math.floor(trainX.length / 2)]);
  trained = { health, rul, metrics, trend, medians, rulRange: Math.max(...trainRul) - Math.min(...trainRul) || 1 };
  console.info(`[model] ${VERSION}: ${train.length} training / ${test.length} held-out rows, ${metrics.trainingMs} ms`);
  console.table({ health: targets.health, rul: targets.rul });
  return metrics;
}

export function getModelMetrics(): ModelMetrics {
  if (!trained) throw new Error("Model is not initialized.");
  return trained.metrics;
}
const std = (values: number[]) => {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
};
export function predictTelemetry(input: ModelInput): ModelPrediction {
  if (!trained) throw new Error("Model is not initialized.");
  const x = vector(input);
  if (x.some(value => !Number.isFinite(value))) throw new Error("All model inputs must be finite numbers.");
  const estimate = (values: number[]) => applyEdgeTrend(trained!.health.predict([values])[0], trained!.rul.predict([values])[0], values[2], trained!.trend);
  const { health: healthIndex, rul } = estimate(x);
  const contributions = FEATURE_NAMES.map((feature, column) => {
    const reference = trained!.medians[column];
    const counterfactual = [...x];
    counterfactual[column] = reference;
    const alternate = estimate(counterfactual);
    return { feature, reference, health: healthIndex - alternate.health, rul: rul - alternate.rul };
  });
  const top = (target: "health" | "rul") => contributions.map(({ feature, reference, ...deltas }) => ({ feature, reference, delta: deltas[target] }))
    .filter(item => Math.abs(item.delta) > 1e-6)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
  const healthIndexStd = std(trained.health.predictionValues([x]).getRow(0));
  const rulHoursStd = std(trained.rul.predictionValues([x]).getRow(0));
  const outside = trained.metrics.features.filter(({ name, min, max }) => input[name] < min || input[name] > max);
  const rangePenalty = outside.reduce((sum, { name, min, max }) => sum + Math.max(min - input[name], input[name] - max, 0) / Math.max(max - min, 0.0001), 0);
  const confidence = Math.round(Math.min(outside.length ? 50 : 99, 100 * Math.exp(-2 * (healthIndexStd + rulHoursStd / trained.rulRange + rangePenalty))));
  const anomaly = 1 - healthIndex;
  return { health: Math.round(healthIndex * 100), healthIndex, rul, confidence, anomaly,
    validation: outside.length ? "OUT_OF_TRAINING_RANGE" : anomaly > .66 ? "CRITICAL_MODEL_RISK" : anomaly > .46 ? "DEGRADED_MODEL_RISK" : "IN_RANGE_ESTIMATE",
    model: VERSION, sampleCount: trained.metrics.dataset.rows,
    outOfRangeFeatures: outside.map(({ name }) => name), uncertainty: { healthIndexStd, rulHoursStd },
    explanations: { method: "Signed difference from this prediction when one feature is replaced with its training median; health deltas in index units, RUL deltas in hours. Local sensitivity, not causal attribution; correlated sensors and clipping can conceal influence.",
      health: top("health"), rul: top("rul") } };
}

/** How much a fully saturated physics residual alone can contribute to the hybrid score. */
export const PHYSICS_RESIDUAL_WEIGHT = 0.6;

/**
 * Fuses the Random Forest anomaly (1 − health index) with the physics residual
 * score as a noisy-OR: either source can raise the hybrid anomaly, neither can
 * lower the other. A saturated physics residual alone yields
 * PHYSICS_RESIDUAL_WEIGHT; a healthy residual leaves the RF anomaly unchanged.
 */
export function fuseAnomaly(forestAnomaly: number, physicsResidualScore: number) {
  const f = Math.max(0, Math.min(1, forestAnomaly));
  const p = Math.max(0, Math.min(1, physicsResidualScore));
  return 1 - (1 - f) * (1 - PHYSICS_RESIDUAL_WEIGHT * p);
}
