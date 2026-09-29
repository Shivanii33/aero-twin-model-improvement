import { describe, expect, it, vi } from "vitest";
import type { StreamControls, TelemetrySnapshot } from "../hooks/usePrognosticStream";
import { assertReadingProvenance, deriveEngineParts, engineReadings, formatReading } from "./engineTelemetry";

const controls: StreamControls = { rpm: 5200, map: 0.84, altitude: 8200, cylinderBias: 18, ambientC: 15 };
const sample = { egt: [840, 840, 840, 840], cht: [185, 185, 185, 185], oilPressure: 30, oilTemp: 100, fuelFlow: 12, ecu: { linkState: "OK" }, can: { crcErrors: 0, counterErrors: 0 }, hybridAnomaly: 0.23, health: 95, rul: 1000, confidence: 90, rpm: 5200, vibration: 2 } as TelemetrySnapshot;
const state = (telemetry: TelemetrySnapshot | null, id: string, settings = controls) => deriveEngineParts(telemetry, settings).find(part => part.id === id)!;

describe("engine telemetry provenance and thresholds", () => {
  it("uses strict EGT watch and critical thresholds", () => {
    expect(state(sample, "cyl-1").state).toBe("NOMINAL");
    expect(state({ ...sample, egt: [841, 850, 851, 840] }, "cyl-1").state).toBe("WATCH");
    expect(state({ ...sample, egt: [841, 850, 851, 840] }, "cyl-2").state).toBe("WATCH");
    expect(state({ ...sample, egt: [841, 850, 851, 840] }, "cyl-3").state).toBe("CRITICAL");
  });
  it("uses oil pressure 25/29 and oil temperature 108/112 boundaries", () => {
    for (const [value, expected] of [[25, "WATCH"], [29, "NOMINAL"], [24, "CRITICAL"]] as const) {
      expect(state({ ...sample, oilPressure: value }, "crankcase").state).toBe(expected);
    }
    for (const [value, expected] of [[108, "NOMINAL"], [112, "WATCH"], [113, "CRITICAL"]] as const) {
      expect(state({ ...sample, oilTemp: value }, "oil").state).toBe(expected);
    }
  });
  it("watches MAP only above 1 bar", () => {
    expect(state(sample, "manifold", { ...controls, map: 1 }).state).toBe("NOMINAL");
    expect(state(sample, "manifold", { ...controls, map: 1.01 }).state).toBe("WATCH");
  });
  it("does not invent sensor values when the sample is null", () => {
    expect(state(null, "cyl-1").state).toBe("UNAVAILABLE");
    expect(state(null, "cyl-1").value).toContain("—");
    expect(formatReading(undefined)).toBe("—");
    expect(engineReadings(null, controls)[0].value).toBeUndefined();
    expect(state(null, "propeller").state).toBe("NO SENSOR");
    expect(state(sample, "propeller").why).toBe("No live sensor for this part");
  });
  it("converts hybrid anomaly to percent without provenance warnings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const readings = engineReadings(sample, controls);
      expect(readings.find(reading => reading.label === "Hybrid anomaly")?.value).toBe(23);
      assertReadingProvenance(readings, sample, controls, true);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});
