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
var clamp = (n, min, max) => Math.max(min, Math.min(max, n));
var round1 = (n) => Math.round(n * 10) / 10;
function isaTemperatureC(altitudeFt) {
  const h = clamp(altitudeFt, 0, ISA_TROPOPAUSE_FT);
  return ISA_SEA_LEVEL_TEMP_C - ISA_LAPSE_C_PER_FT * h;
}
function isaDensityRatio(altitudeFt) {
  const h = clamp(altitudeFt, 0, ISA_TROPOPAUSE_FT);
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
    clamp(chtSpatial / CHT_SPATIAL_FULL_SCALE_C, 0, 1),
    clamp(egtSpatial / EGT_SPATIAL_FULL_SCALE_C, 0, 1),
    clamp(oilTemp / OIL_EXCESS_FULL_SCALE_C, 0, 1)
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
var clamp2 = (n, min, max) => Math.max(min, Math.min(max, n));
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
function createEngineSimulator(seed = 42) {
  const random = mulberry32(seed);
  let soakC = 0;
  let lastT = null;
  return {
    sample({ rpm, map, altitude, ambientC, cylinderBias: bias }, t) {
      const ambientStressC = Math.max(0, ambientC - isaTemperatureC(altitude)) * 0.4;
      const stress = Math.max(0, (rpm - 4800) / 2400) + Math.max(0, map - 0.72) * 1.4;
      const dt = lastT === null ? 0 : clamp2(t - lastT, 0, 1);
      lastT = t;
      const excess = stress - SOAK_STRESS_THRESHOLD;
      soakC = excess > 0 ? Math.min(SOAK_MAX_C, soakC + SOAK_RATE_C_PER_S * excess * dt) : soakC * Math.exp(-dt / SOAK_RECOVERY_TAU_S);
      const resonance = 1.6 * Math.exp(-(((rpm - MOUNT_RESONANCE_RPM) / MOUNT_RESONANCE_WIDTH_RPM) ** 2));
      const instability = Math.max(0, bias - UNSTABLE_BIAS_ONSET) * 0.35 + Math.max(0, 0.5 - map) * 30;
      const oilPressure = Number(clamp2(31 - stress * 5.2 - bias * 0.12 + Math.sin(t * 3) * 0.25, 18, 34).toFixed(1));
      const vibration = Number((2.1 + stress * 1.8 + bias / 30 + resonance * 0.4 + Math.abs(Math.sin(t * 4)) * 0.45).toFixed(2));
      const fuelFlow = Number((18 + rpm / 620 + map * 9 + bias / 12 + Math.sin(t * 2) * 0.12).toFixed(2));
      const batteryVoltage = Number((27.7 + Math.sin(t * 1.8) * 0.18 - Math.max(0, vibration - 4) * 0.2).toFixed(2));
      const alternatorHealth = Math.round(clamp2(99 - Math.max(0, 28 - batteryVoltage) * 8 - Math.max(0, vibration - 4) * 4, 65, 100));
      const injectionTiming = Number((18.5 + Math.sin(t * 1.3) * 0.22 - bias / 140).toFixed(2));
      const oilTemp = Math.round(94 + stress * 13 + soakC * 0.6 + ambientStressC);
      const rpmStress = Math.max(0, (rpm - 4800) / 2400);
      const cht = [214, 216, 213, 215].map((v, i) => Math.round(v + bias * (i === 2 ? 0.8 : 0.03) + rpmStress * (i + 1) + soakC + ambientStressC));
      const egt = [808, 821, 836, 830].map((v, i) => {
        const scatter = (random() * 2 - 1) * (i === 2 ? instability : instability * 0.15);
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
var clamp3 = (n, min, max) => Math.max(min, Math.min(max, n));
function instantaneousFaults(s) {
  const { vibration, fuelFlow, injectionTiming, oilPressure, oilTemp, t } = s;
  return [
    { type: "misfire", severity: vibration > 4.4 ? "HIGH" : "LOW", confidence: clamp3(vibration / 6, 0.12, 0.98), detail: `Vibration ${vibration} mm/s with unstable combustion residual` },
    { type: "injector abnormality", severity: fuelFlow > 31 || Math.abs(injectionTiming - 18.5) > 0.4 ? "MEDIUM" : "LOW", confidence: clamp3((fuelFlow - 20) / 18 + Math.abs(injectionTiming - 18.5), 0.1, 0.96), detail: `Fuel flow ${fuelFlow} L/h; injection timing ${injectionTiming}\xB0` },
    { type: "coking/lubrication issue", severity: oilPressure < 24 || oilPressure > 33 ? "HIGH" : "LOW", confidence: clamp3((32 - oilPressure) / 14, 0.1, 0.97), detail: `Oil pressure ${oilPressure} psi and oil temperature ${Math.round(oilTemp)} \xB0C` },
    { type: "sensor drift", severity: Math.abs(Math.sin(t / 9)) > 0.92 ? "MEDIUM" : "LOW", confidence: 0.22 + Math.abs(Math.sin(t / 9)) * 0.55, detail: "Cross-sensor residual disagreement monitor" }
  ];
}

// server/ecu-interface.ts
function createSimulatedCanAdapter(engine) {
  const encoder = createEncoderState();
  return { readCycle: (controls2, tSeconds) => encodeFrames(engine.sample(controls2, tSeconds), encoder) };
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
    step(controls2, tSeconds) {
      heartbeat = (heartbeat + 1) % 65536;
      const rpmTarget = controls2.rpm;
      const fuelSchedule = Number((18 + rpmTarget / 620 + controls2.map * 9).toFixed(2));
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
function createOnboardPipeline(engine, canAdapter = createSimulatedCanAdapter(engine), ecu = createEcuInterface()) {
  const decoder = createDecoderState();
  return {
    next(controls2, nowMs = Date.now()) {
      const t = nowMs / 1e3;
      const ecuStatus = ecu.step(controls2, t);
      const { frames, saturated } = canAdapter.readCycle(controls2, t);
      const s = decodeFrames(frames, decoder);
      const physics = computeResiduals(
        { cht: [s.cht1, s.cht2, s.cht3, s.cht4], egt: [s.egt1, s.egt2, s.egt3, s.egt4], oilTemp: s.oilTemp },
        computeBaseline({ rpm: s.rpm, map: s.map, altitude: s.altitude, ambientC: controls2.ambientC })
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

// server/link-security.ts
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
function linkKey() {
  const key = process.env.AEROTWIN_LINK_KEY;
  if (!key || key.length < 32) throw new Error("AEROTWIN_LINK_KEY must be a random secret of at least 32 characters");
  return key;
}
function signEnvelope(envelope, key) {
  const body = JSON.stringify(envelope);
  const signature = createHmac("sha256", key).update(body).digest("hex");
  return { body, signature };
}
function createLinkSender(key, source = randomUUID()) {
  let sequence = 0;
  return (payload) => signEnvelope({ source, sequence: ++sequence, sentAt: Date.now(), payload }, key);
}

// server/onboard.ts
var url = process.env.AEROTWIN_GROUND_URL || "http://127.0.0.1:3001";
var target = new URL("/internal/telemetry", url);
if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname) && target.protocol !== "https:") {
  throw new Error("Remote ground links require HTTPS; do not send telemetry over plaintext networks");
}
var send = createLinkSender(linkKey());
var pipeline = createOnboardPipeline(createEngineSimulator());
var controls = parseControls({});
var stopped = false;
var failures = 0;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
async function tick() {
  const { body, signature } = send(pipeline.next(controls));
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telemetry-Signature": signature },
      body,
      signal: AbortSignal.timeout(2e3)
    });
    if (!response.ok) throw new Error(`Ground rejected telemetry (${response.status})`);
    failures = 0;
  } catch (error) {
    if (++failures === 1 || failures % 30 === 0) console.error("Onboard link unavailable:", error);
  }
}
console.log(`Onboard simulator sending reduced signed telemetry to ${target.origin}`);
while (!stopped) {
  const started = Date.now();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, TICK_INTERVAL_MS - (Date.now() - started))));
}
