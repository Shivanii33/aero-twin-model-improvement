/**
 * CAN-FD frame layer between the simulated engine and the analytics pipeline.
 *
 * Every telemetry value reaches the physics / RF / fault stages only after it
 * has been packed into a CAN-FD frame and decoded back out, so resolution
 * (quantization), range limits (saturation) and integrity checks behave the
 * way they would on a real ECU bus.
 *
 * Frame layout (all multi-byte signals little-endian):
 *   byte 0          alive counter in the low nibble (0–15, increments per frame ID)
 *   bytes 1..n      signals, in the order listed in the frame spec
 *   bytes n+1..L-2  padding (0xFF)
 *   byte L-1        CRC-8 SAE-J1850 over the 4 frame-ID bytes + bytes 0..L-2
 * where L is a legal CAN-FD data length (0–8, 12, 16, 20, 24, 32, 48, 64).
 */
import type { CanFrameSummary } from "../shared/telemetry";

export const CAN_FD_LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64] as const;
export const ECU_SOURCE_ADDRESS = 0xe5;

export type SignalName =
  | "rpm" | "map" | "altitude" | "fuelFlow" | "injectionTiming"
  | "cht1" | "cht2" | "cht3" | "cht4" | "egt1" | "egt2" | "egt3" | "egt4"
  | "oilPressure" | "oilTemp"
  | "vibration" | "vibOrderHalf" | "vibOrder1" | "vibOrder2"
  | "batteryVoltage" | "alternatorHealth";

export type EngineSignals = Record<SignalName, number>;

type SignalSpec = {
  name: SignalName;
  bytes: 1 | 2;
  signed?: boolean;
  /** Raw counts per engineering unit. */
  scale: number;
  /** Engineering value when raw = 0. */
  offset: number;
};

type FrameSpec = { id: number; name: string; dlc: number; signals: SignalSpec[] };

const u16 = (name: SignalName, scale: number, offset = 0): SignalSpec => ({ name, bytes: 2, scale, offset });
const tempSignal = (name: SignalName) => u16(name, 10, -40);

// 29-bit J1939-style IDs: priority 6, proprietary-B PGNs 0xFF50–0xFF54, source 0xE5.
export const FRAME_SPECS: readonly FrameSpec[] = [
  {
    id: 0x18ff50e5, name: "EEC_SPEED_LOAD", dlc: 12,
    signals: [u16("rpm", 4), u16("map", 1000), u16("fuelFlow", 100), { name: "injectionTiming", bytes: 2, signed: true, scale: 100, offset: 0 }, u16("altitude", 2, -1000)],
  },
  {
    id: 0x18ff51e5, name: "CYL_TEMPS", dlc: 20,
    signals: (["cht1", "cht2", "cht3", "cht4", "egt1", "egt2", "egt3", "egt4"] as const).map(tempSignal),
  },
  { id: 0x18ff52e5, name: "LUBRICATION", dlc: 8, signals: [u16("oilPressure", 100), tempSignal("oilTemp")] },
  { id: 0x18ff53e5, name: "VIBRATION", dlc: 12, signals: [u16("vibration", 100), u16("vibOrderHalf", 100), u16("vibOrder1", 100), u16("vibOrder2", 100)] },
  { id: 0x18ff54e5, name: "ELECTRICAL", dlc: 8, signals: [u16("batteryVoltage", 100), { name: "alternatorHealth", bytes: 1, scale: 1, offset: 0 }] },
];

for (const spec of FRAME_SPECS) {
  const needed = 2 + spec.signals.reduce((n, s) => n + s.bytes, 0);
  if (!CAN_FD_LENGTHS.includes(spec.dlc as (typeof CAN_FD_LENGTHS)[number]) || spec.dlc < needed) {
    throw new Error(`CAN-FD frame ${spec.name} has invalid length ${spec.dlc} (needs ≥ ${needed})`);
  }
}

export type CanFdFrame = { id: number; dlc: number; data: Uint8Array };

/** CRC-8 SAE-J1850: poly 0x1D, init 0xFF, final XOR 0xFF. */
export function crc8J1850(bytes: ArrayLike<number>) {
  let crc = 0xff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x1d) & 0xff : (crc << 1) & 0xff;
  }
  return crc ^ 0xff;
}

function frameCrc(id: number, data: Uint8Array) {
  const idBytes = [id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, (id >>> 24) & 0xff];
  return crc8J1850(idBytes.concat(Array.from(data.subarray(0, data.length - 1))));
}

function rawRange(signal: SignalSpec) {
  const bits = signal.bytes * 8;
  return signal.signed ? [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1] : [0, 2 ** bits - 1];
}

export type EncoderState = { counters: Map<number, number> };
export const createEncoderState = (): EncoderState => ({ counters: new Map() });

export function encodeFrames(signals: EngineSignals, state: EncoderState) {
  const saturated: SignalName[] = [];
  const frames = FRAME_SPECS.map((spec): CanFdFrame => {
    const data = new Uint8Array(spec.dlc).fill(0xff);
    const counter = ((state.counters.get(spec.id) ?? -1) + 1) & 0x0f;
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
      for (let b = 0; b < signal.bytes; b++) data[cursor + b] = (unsigned >>> (8 * b)) & 0xff;
      cursor += signal.bytes;
    }
    data[spec.dlc - 1] = frameCrc(spec.id, data);
    return { id: spec.id, dlc: spec.dlc, data };
  });
  return { frames, saturated };
}

export type DecoderState = { lastCounter: Map<number, number>; decoded: number; crcErrors: number; counterErrors: number };
export const createDecoderState = (): DecoderState => ({ lastCounter: new Map(), decoded: 0, crcErrors: 0, counterErrors: 0 });

export class CanFdIntegrityError extends Error {}

export function decodeFrames(frames: CanFdFrame[], state: DecoderState): EngineSignals {
  const out: Partial<EngineSignals> = {};
  for (const frame of frames) {
    const spec = FRAME_SPECS.find((s) => s.id === frame.id);
    if (!spec) throw new CanFdIntegrityError(`Unknown CAN-FD frame 0x${frame.id.toString(16)}`);
    if (frame.dlc !== spec.dlc || frame.data.length !== spec.dlc) throw new CanFdIntegrityError(`${spec.name}: length ${frame.data.length} ≠ ${spec.dlc}`);
    if (frame.data[spec.dlc - 1] !== frameCrc(frame.id, frame.data)) {
      state.crcErrors++;
      throw new CanFdIntegrityError(`${spec.name}: CRC mismatch`);
    }
    const counter = frame.data[0] & 0x0f;
    const previous = state.lastCounter.get(frame.id);
    if (previous !== undefined && counter !== ((previous + 1) & 0x0f)) state.counterErrors++;
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
  const missing = FRAME_SPECS.flatMap((s) => s.signals).filter((s) => out[s.name] === undefined);
  if (missing.length) throw new CanFdIntegrityError(`Missing CAN-FD signals: ${missing.map((s) => s.name).join(", ")}`);
  return out as EngineSignals;
}

export function summarizeFrame(frame: CanFdFrame): CanFrameSummary {
  const spec = FRAME_SPECS.find((s) => s.id === frame.id);
  return {
    id: `0x${frame.id.toString(16).toUpperCase()}`,
    name: spec?.name ?? "UNKNOWN",
    dlc: frame.dlc,
    data: Array.from(frame.data, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "),
  };
}
