import assert from "node:assert/strict";
import { test, before } from "node:test";
import { initializeModel, fuseAnomaly, PHYSICS_RESIDUAL_WEIGHT } from "./model";
import { createEngineSimulator, createEnduranceEngineSimulator, enduranceHours } from "./engine-simulator";
import { createTelemetryPipeline } from "./telemetry-pipeline";
import { computeBaseline, computeResiduals, isaDensityRatio, isaTemperatureC, REFERENCE_CRUISE } from "./physics-baseline";
import {
  crc8J1850, createDecoderState, createEncoderState, decodeFrames, encodeFrames, CanFdIntegrityError, CAN_FD_LENGTHS, FRAME_SPECS, type EngineSignals,
} from "./can-fd";
import { detectAbnormalVibration, detectCombustionInstability, detectOverheatingTrend, detectSensorFailure, activeFaults, type FaultSample } from "./fault-detection";
import { recommendMaintenance } from "./maintenance-advisory";
import { predictTelemetry } from "./model";
import type { TelemetryControls } from "./telemetry-controls";

before(() => { initializeModel(); });

const CRUISE: TelemetryControls = { rpm: 5203, map: 0.84, altitude: 8200, cylinderBias: 18, ambientC: 15 };

function runPipeline(controls: TelemetryControls, ticks: number) {
  const pipeline = createTelemetryPipeline(createEngineSimulator());
  let last!: ReturnType<typeof pipeline.next>;
  for (let i = 0; i < ticks; i++) last = pipeline.next(controls, 1_000_000 + i * 150);
  return last;
}
const candidate = (payload: ReturnType<typeof runPipeline>, type: string) => {
  const found = payload.faultCandidates.find((f) => f.type === type);
  assert.ok(found, `missing fault candidate ${type}`);
  return found;
};

test("ISA atmosphere matches standard reference values", () => {
  assert.equal(isaTemperatureC(0), 15);
  assert.ok(Math.abs(isaTemperatureC(10000) - -4.81) < 0.01);
  assert.equal(isaDensityRatio(0), 1);
  assert.ok(Math.abs(isaDensityRatio(10000) - 0.7385) < 0.001);
});

test("physics baseline reproduces the calibrated reference cruise point and scales with load and altitude", () => {
  const ref = computeBaseline({ rpm: REFERENCE_CRUISE.rpm, map: REFERENCE_CRUISE.map, altitude: REFERENCE_CRUISE.altitudeFt, ambientC: isaTemperatureC(REFERENCE_CRUISE.altitudeFt) });
  assert.equal(ref.chargeDensityRatio, 1);
  assert.deepEqual(ref.cht, [214.5, 216.5, 213.5, 215.5]);
  assert.equal(ref.oilTemp, 98.4);
  assert.ok(ref.withinCalibration);

  const highLoad = computeBaseline({ rpm: 6800, map: 1.2, altitude: 8200, ambientC: isaTemperatureC(8200) });
  assert.ok(highLoad.egt.every((v, i) => v > ref.egt[i]), "EGT rises with RPM and charge density");
  assert.ok(highLoad.oilTemp > ref.oilTemp);

  const thinAir = computeBaseline({ rpm: 5200, map: 0.84, altitude: 16000, ambientC: isaTemperatureC(16000) });
  assert.ok(thinAir.chargeDensityRatio > 1, "same MAP in colder air is a denser charge");
  assert.ok(thinAir.cht[0] > ref.cht[0], "thinner cooling air raises CHT");
  assert.equal(computeBaseline({ rpm: 1500, map: 0.84, altitude: 8200, ambientC: isaTemperatureC(8200) }).withinCalibration, false);
});

test("ambient temperature changes independently of altitude and hot weather increases measured temperatures", () => {
  const cool = computeBaseline({ rpm: 5200, map: 0.84, altitude: 8200, ambientC: 15 });
  const hot = computeBaseline({ rpm: 5200, map: 0.84, altitude: 8200, ambientC: 50 });
  assert.equal(hot.densityRatio, cool.densityRatio);
  assert.equal(hot.ambientTempC, 50);
  assert.ok(hot.cht[0] > cool.cht[0]);

  const coolSample = createEngineSimulator().sample({ ...CRUISE, ambientC: 15 }, 1000);
  const hotSample = createEngineSimulator().sample({ ...CRUISE, ambientC: 50 }, 1000);
  assert.ok(hotSample.cht1 > coolSample.cht1);
  assert.ok(hotSample.egt1 > coolSample.egt1);
  assert.ok(hotSample.oilTemp > coolSample.oilTemp);

  const payload = runPipeline({ ...CRUISE, ambientC: 50 }, 60);
  assert.equal(payload.physics.ambientTempC, 50);
});

test("physics residual score is driven by cylinder-to-cylinder spread, not a common offset", () => {
  const baseline = computeBaseline({ rpm: 5200, map: 0.84, altitude: 8200, ambientC: isaTemperatureC(8200) });
  const uniformShift = computeResiduals({ cht: baseline.cht.map((v) => v + 8), egt: baseline.egt.map((v) => v + 8), oilTemp: baseline.oilTemp }, baseline);
  assert.equal(uniformShift.residuals.chtSpatial, 0);
  assert.equal(uniformShift.residualScore, 0);

  const hotCylinder = computeResiduals({ cht: baseline.cht.map((v, i) => (i === 2 ? v + 25 : v)), egt: baseline.egt, oilTemp: baseline.oilTemp }, baseline);
  assert.equal(hotCylinder.residuals.chtSpatial, 25);
  assert.equal(hotCylinder.residualScore, 1);
});

test("hybrid anomaly never lowers the RF anomaly and is bounded by physics weight alone", () => {
  assert.equal(fuseAnomaly(0.4, 0), 0.4);
  assert.ok(Math.abs(fuseAnomaly(0, 1) - PHYSICS_RESIDUAL_WEIGHT) < 1e-12);
  assert.ok(fuseAnomaly(0.5, 0.5) > 0.5);
  assert.equal(fuseAnomaly(1, 0.3), 1);
});

test("CRC-8 SAE-J1850 matches the published check value", () => {
  assert.equal(crc8J1850(Array.from("123456789", (c) => c.charCodeAt(0))), 0x4b);
});

test("CAN-FD frames use legal lengths and round-trip every signal at bus resolution", () => {
  for (const spec of FRAME_SPECS) assert.ok((CAN_FD_LENGTHS as readonly number[]).includes(spec.dlc));
  const signals = createEngineSimulator().sample(CRUISE, 1000);
  const { frames, saturated } = encodeFrames(signals, createEncoderState());
  assert.deepEqual(saturated, []);
  const decoded = decodeFrames(frames, createDecoderState());
  for (const spec of FRAME_SPECS) for (const s of spec.signals) {
    assert.ok(Math.abs(decoded[s.name] - signals[s.name]) <= 0.5 / s.scale + 1e-9, `${s.name}: ${decoded[s.name]} vs ${signals[s.name]}`);
  }
});

test("CAN-FD decoder rejects corrupted frames and counts dropped frames", () => {
  const signals = createEngineSimulator().sample(CRUISE, 1000);
  const encoder = createEncoderState();
  const decoder = createDecoderState();
  const { frames } = encodeFrames(signals, encoder);
  frames[1].data[3] ^= 0x10;
  assert.throws(() => decodeFrames(frames, decoder), CanFdIntegrityError);
  assert.equal(decoder.crcErrors, 1);

  const fresh = createDecoderState();
  decodeFrames(encodeFrames(signals, encoder).frames, fresh);
  encodeFrames(signals, encoder);
  decodeFrames(encodeFrames(signals, encoder).frames, fresh);
  assert.equal(fresh.counterErrors, FRAME_SPECS.length);
});

test("CAN-FD encoder saturates out-of-range signals and reports them", () => {
  const signals: EngineSignals = { ...createEngineSimulator().sample(CRUISE, 1000), oilTemp: 9000 };
  const { frames, saturated } = encodeFrames(signals, createEncoderState());
  assert.deepEqual(saturated, ["oilTemp"]);
  assert.equal(decodeFrames(frames, createDecoderState()).oilTemp, (0xffff / 10) - 40);
});

test("pipeline payload carries decoded telemetry, physics, hybrid anomaly and bus status", () => {
  const p = runPipeline(CRUISE, 5);
  assert.equal(p.can.frames, 5 * FRAME_SPECS.length);
  assert.equal(p.can.crcErrors, 0);
  assert.equal(p.can.counterErrors, 0);
  assert.equal(p.cht.length, 4);
  assert.ok(p.hybridAnomaly >= p.anomaly);
  assert.ok(p.physics.residuals.chtSpatial > 5, "default cruise has a cylinder-3 CHT bias");
  assert.ok(p.faults.every((f) => f.confidence > 0.42));
  assert.ok(p.advisories.length > 0);
  assert.ok(p.advisories.every(a => a.hoursToAction >= 0 && a.component && a.action));
  assert.ok(p.explanations.health.length >= 1 && p.explanations.health.length <= 3);
  assert.ok(p.explanations.rul.length >= 1 && p.explanations.rul.length <= 3);
});

test("temporal detectors stay quiet at steady cruise", () => {
  const p = runPipeline({ ...CRUISE, cylinderBias: 0 }, 300);
  for (const type of ["combustion instability", "overheating trend", "abnormal vibration"]) {
    assert.ok(candidate(p, type).confidence < 0.2, `${type} = ${candidate(p, type).confidence}`);
  }
});

test("combustion instability fires on cycle-to-cycle EGT scatter", () => {
  const f = candidate(runPipeline({ ...CRUISE, cylinderBias: 60 }, 60), "combustion instability");
  assert.ok(f.confidence > 0.42);
  assert.equal(f.severity, "HIGH");
  assert.match(f.detail, /CYL 3/);
});

test("overheating trend fires while temperatures climb above the physics baseline and persists at an elevated plateau", () => {
  const climbing = candidate(runPipeline({ ...CRUISE, rpm: 7200, map: 1.4 }, 60), "overheating trend");
  assert.ok(climbing.confidence > 0.8);
  assert.equal(climbing.severity, "HIGH");
  const plateau = candidate(runPipeline({ ...CRUISE, rpm: 7200, map: 1.4 }, 1200), "overheating trend");
  assert.ok(plateau.confidence > 0.42);
});

test("abnormal vibration fires when the 1× order dominates the firing order", () => {
  const f = candidate(runPipeline({ ...CRUISE, rpm: 5850 }, 60), "abnormal vibration");
  assert.ok(f.confidence > 0.42);
  assert.ok(candidate(runPipeline(CRUISE, 60), "abnormal vibration").confidence < 0.2);
});

test("endurance clock degrades sensors through the existing model and fault pipeline without changing normal telemetry", () => {
  assert.equal(enduranceHours(1000, 181000), 24);
  const controls = { ...CRUISE, cylinderBias: 0 };
  const normal = createTelemetryPipeline(createEngineSimulator());
  let hours = 0;
  const endurance = createTelemetryPipeline(createEnduranceEngineSimulator(() => hours));
  const beginning = endurance.next(controls, 1_000_000);
  const normalBeginning = normal.next(controls, 1_000_000);
  assert.deepEqual(beginning.cht, normalBeginning.cht);
  assert.equal(beginning.oilPressure, normalBeginning.oilPressure);
  let worn = beginning;
  let normalLater = normalBeginning;
  for (let i = 1; i <= 1200; i++) {
    hours = i * 0.02;
    worn = endurance.next(controls, 1_000_000 + i * 150);
    normalLater = normal.next(controls, 1_000_000 + i * 150);
  }
  assert.ok(worn.oilPressure < beginning.oilPressure - 10);
  assert.ok(worn.vibration > beginning.vibration + 3);
  assert.ok(worn.physics.residuals.cht.every((residual, i) => residual > beginning.physics.residuals.cht[i] + 25));
  assert.ok(worn.physics.residuals.egt.every((residual, i) => residual > beginning.physics.residuals.egt[i] + 30));
  assert.ok(worn.hybridAnomaly > beginning.hybridAnomaly, "physics residuals raise the hybrid anomaly despite flat RF estimates");
  assert.ok(worn.faults.some(fault => fault.type === "overheating trend"));
  assert.ok(worn.faults.some(fault => fault.type === "abnormal vibration"));
  assert.ok(normalLater.oilPressure > worn.oilPressure + 10);
  assert.ok(normalLater.health >= beginning.health - 2);
  const reset = createTelemetryPipeline(createEnduranceEngineSimulator(() => 0)).next(controls, 2_000_000);
  assert.ok(reset.oilPressure > worn.oilPressure + 10);
});

test("sensor failure detects dropout, physical range breach and stalled channel without steady-state false positives", () => {
  const base: FaultSample = { t: 0, rpm: 5200, fuelFlow: 31, injectionTiming: 18.5, vibration: 2.1,
    vibrationOrders: { half: 0.5, first: 1.1, second: 2.3 }, oilPressure: 30, oilTemp: 98,
    egtResidual: [0, 0, 0, 0], chtResidualMean: 0, oilTempResidual: 0 };
  assert.equal(detectSensorFailure(base, []), null);
  const steady = Array.from({ length: 11 }, (_, i) => ({ ...base, t: i * 0.15 }));
  assert.equal(detectSensorFailure({ ...base, t: 1.65 }, steady), null);
  const changing = steady.map((s, i) => ({ ...s, rpm: 5100 + i * 20, fuelFlow: 27 + i * 0.1,
    oilTemp: 97 + i * 0.1, vibration: 1.8 + i * 0.05 }));
  const flat = { ...base, t: 1.65, rpm: 5320, fuelFlow: 28.2, oilTemp: 98.2, vibration: 2.4 };
  assert.match(detectSensorFailure(flat, changing)!.detail, /Flatline: oilPressure/);
  assert.ok(activeFaults(flat, changing).some(f => f.type === "sensor failure"));
  assert.match(detectSensorFailure({ ...base, t: 1.8, oilPressure: NaN }, steady)!.detail, /Dropout: oilPressure/);
  assert.match(detectSensorFailure({ ...base, t: 1.8, oilTemp: 300 }, steady)!.detail, /Out-of-range: oilTemp/);
  assert.match(detectSensorFailure({ ...base, t: 4 }, steady)!.detail, /Dropout: telemetry gap/);
  assert.equal(detectSensorFailure({ ...base, t: 0.15 }, [base]), null);
});

test("maintenance advisories prioritize active faults and limit hours by model RUL", () => {
  const prediction = predictTelemetry({ rpm: 2500, manifold_pressure_bar: 1.03, oil_temp_c: 118,
    oil_press_bar: 2, cht_cyl1: 150, cht_cyl2: 150, cht_cyl3_anomaly: 280, cht_cyl4: 150 });
  const faults = [{ type: "sensor failure" as const, severity: "HIGH" as const, confidence: 0.95, detail: "flatline" }];
  const advice = recommendMaintenance(prediction, faults);
  assert.equal(advice[0].component, "Sensor network");
  assert.equal(advice[0].urgency, "IMMEDIATE");
  assert.equal(advice[0].hoursToAction, 0);
  assert.ok(recommendMaintenance(prediction, [])[0].hoursToAction <= prediction.rul / 2);
});

test("temporal detectors wait for enough history", () => {
  const sample: FaultSample = {
    t: 0, rpm: 5200, fuelFlow: 34, injectionTiming: 18.4, vibration: 3, vibrationOrders: { half: 0.1, first: 3, second: 0.8 },
    oilPressure: 30, oilTemp: 98, egtResidual: [0, 0, 30, 0], chtResidualMean: 40, oilTempResidual: 20,
  };
  assert.equal(detectCombustionInstability(sample, []), null);
  assert.equal(detectOverheatingTrend(sample, []), null);
  assert.equal(detectAbnormalVibration(sample, []), null);
});
