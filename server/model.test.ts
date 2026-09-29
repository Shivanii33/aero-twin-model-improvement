import assert from "node:assert/strict";
import { test, before } from "node:test";
import { initializeModel, getModelMetrics, predictTelemetry, scoreRegression, shuffled, timeOrderedSplit, fitEdgeTrend, applyEdgeTrend } from "./model";
import { parseControls } from "./telemetry-controls";
import { FEATURE_NAMES } from "../shared/model";

before(() => { initializeModel(); });

test("startup trains two regressors with a chronological 800/200 split and no target leakage", () => {
  const metrics = getModelMetrics();
  assert.equal(metrics.dataset.rows, 1000);
  assert.equal(metrics.dataset.trainRows, 800);
  assert.equal(metrics.dataset.testRows, 200);
  assert.equal(initializeModel(), metrics);
  assert.equal(metrics.dataset.sha256.length, 64);
  assert.deepEqual(metrics.features.map(feature => feature.name), [...FEATURE_NAMES]);
  assert.ok(!metrics.features.some(feature => /target|timestamp/.test(feature.name)));
  for (const target of Object.values(metrics.targets)) {
    assert.ok(Number.isFinite(target.mae) && target.mae >= 0);
    assert.ok(Number.isFinite(target.rmse) && target.rmse >= target.mae);
  }
  assert.equal(metrics.featureImportance.length, 8);
  assert.ok(metrics.featureImportance.every(item => Number.isFinite(item.health) && Number.isFinite(item.rul)));
});

test("time-based split trains on the earliest 80% and tests on the later 20%", () => {
  const rows = shuffled(Array.from({ length: 1000 }, (_, i) => ({ timestamp_sec: i * 10 })), 7);
  const { train, test: held } = timeOrderedSplit(rows, 0.8);
  assert.equal(train.length, 800);
  assert.equal(held.length, 200);
  assert.equal(train.at(-1)!.timestamp_sec, 7990);
  assert.equal(held[0].timestamp_sec, 8000);
  assert.ok(Math.max(...train.map(r => r.timestamp_sec)) < Math.min(...held.map(r => r.timestamp_sec)));
  const metrics = getModelMetrics();
  assert.match(metrics.split.method, /time-based/i);
  assert.ok(metrics.split.trainTimestampSec[1] < metrics.split.testTimestampSec[0]);
});

test("MAE and RMSE use regression errors rather than classification metrics", () => {
  const result = scoreRegression([1, 2, 3], [1, 4, 2], "hours");
  assert.equal(result.mae, 1);
  assert.equal(result.rmse, Math.sqrt(5 / 3));
  assert.equal(result.r2, -1.5);
  assert.equal(scoreRegression([1, 1], [1, 1], "").r2, null);
  assert.throws(() => scoreRegression([], [], ""));
});

const healthy = { rpm: 2500, manifold_pressure_bar: 1.03, oil_temp_c: 80, oil_press_bar: 4.5, cht_cyl1: 150, cht_cyl2: 150, cht_cyl3_anomaly: 150, cht_cyl4: 150 };

test("predictions are deterministic, bounded, feature-dependent and penalize extrapolation", () => {
  const good = predictTelemetry(healthy);
  const degraded = predictTelemetry({ ...healthy, oil_temp_c: 118, oil_press_bar: 2, cht_cyl3_anomaly: 280 });
  const outside = predictTelemetry({ ...healthy, rpm: 7200, cht_cyl1: 230 });
  assert.deepEqual(good, predictTelemetry(healthy));
  assert.ok(good.health > degraded.health);
  assert.ok(good.rul > degraded.rul);
  assert.equal(good.outOfRangeFeatures.length, 0);
  assert.deepEqual(outside.outOfRangeFeatures, ["rpm", "cht_cyl1"]);
  assert.ok(outside.confidence < good.confidence && outside.confidence <= 50);
  assert.equal(outside.validation, "OUT_OF_TRAINING_RANGE");
  assert.equal(good.anomaly, 1 - good.healthIndex);
  assert.ok(good.health >= 0 && good.health <= 100 && good.rul >= 0);
  assert.throws(() => predictTelemetry({ ...healthy, rpm: NaN }));
});

test("training-only edge slope extrapolates late-life wear and preserves physical bounds", () => {
  const metrics = getModelMetrics();
  assert.ok(metrics.baselineTargets.health.r2! < 0 && metrics.baselineTargets.rul.r2! < 0);
  assert.ok(metrics.targets.health.mae < metrics.baselineTargets.health.mae);
  assert.ok(metrics.targets.rul.mae < metrics.baselineTargets.rul.mae);
  assert.ok(metrics.targets.health.r2! > 0 && metrics.targets.rul.r2! > 0);
  const train = Array.from({ length: 100 }, (_, i) => ({ oil_temp_c: 80 + i / 10, target_health_index: 1 - i / 100, target_rul_hours: 24 - i / 5 }));
  const trend = fitEdgeTrend(train as Parameters<typeof fitEdgeTrend>[0]);
  const before = applyEdgeTrend(0.9, 18, trend.anchorTemp, trend);
  const late = applyEdgeTrend(0.9, 18, trend.anchorTemp + 20, trend);
  assert.ok(late.health < before.health && late.rul < before.rul);
  assert.ok(late.health >= 0 && late.rul >= 0);
});

test("local feature contributions are deterministic signed counterfactual deltas", () => {
  const prediction = predictTelemetry(healthy);
  const altered = predictTelemetry({ ...healthy, oil_temp_c: 115 });
  for (const target of ["health", "rul"] as const) {
    assert.ok(prediction.explanations[target].length <= 3);
    assert.ok(altered.explanations[target].some(c => c.feature === "oil_temp_c"));
    assert.ok(prediction.explanations[target].every(c => Number.isFinite(c.delta) && Number.isFinite(c.reference) && Math.abs(c.delta) > 1e-6));
    assert.ok(altered.explanations[target].every((c, i, entries) => i === 0 || Math.abs(entries[i - 1].delta) >= Math.abs(c.delta)));
  }
});

test("telemetry inputs reject malformed, repeated, nonfinite and out-of-bounds values", () => {
  assert.equal(parseControls({}).rpm, 5203);
  assert.equal(parseControls({}).ambientC, 15);
  assert.equal(parseControls({ ambientC: "-10" }).ambientC, -10);
  assert.equal(parseControls({ ambientC: "50" }).ambientC, 50);
  assert.equal(parseControls({ cylinderBias: "0" }).cylinderBias, 0);
  assert.equal(parseControls({ rpm: "3200", map: "0.42" }).map, .42);
  for (const query of [{ rpm: "NaN" }, { rpm: "Infinity" }, { rpm: "" }, { rpm: ["4000", "5000"] }, { rpm: "8000" }, { map: "3" }, { cylinderBias: "-1" }, { ambientC: "-11" }, { ambientC: "51" }, { ambientC: "NaN" }]) {
    assert.throws(() => parseControls(query));
  }
});
