import type { ModelPrediction } from "../shared/model";
import type { FaultEvent, MaintenanceAdvisory } from "../shared/telemetry";

const components: Record<FaultEvent["type"], { component: string; action: string }> = {
  misfire: { component: "Combustion system", action: "Inspect ignition and cylinder combustion before release." },
  "injector abnormality": { component: "Fuel injection", action: "Check injector flow, timing and fuel delivery." },
  "coking/lubrication issue": { component: "Lubrication circuit", action: "Verify oil pressure independently; inspect filter and oil circuit." },
  "sensor drift": { component: "Sensor network", action: "Cross-check sensor calibration against an independent instrument." },
  "sensor failure": { component: "Sensor network", action: "Verify the affected channel and wiring before relying on predictions." },
  "combustion instability": { component: "Cylinder combustion", action: "Inspect the affected cylinder and ignition system." },
  "overheating trend": { component: "Cooling system", action: "Inspect cooling airflow, oil temperature and CHT trend." },
  "abnormal vibration": { component: "Rotating assembly", action: "Inspect mounts, rotating balance and vibration pickups." },
};

/** Decision-support scheduling heuristic, not a certified maintenance interval. */
export function recommendMaintenance(prediction: ModelPrediction, faults: FaultEvent[]): MaintenanceAdvisory[] {
  const unreliable = prediction.outOfRangeFeatures.length > 0 || faults.some(f => f.type === "sensor failure");
  const modelHours = Math.max(0, Math.min(24, prediction.rul * 0.5));
  const advisories = faults.map(fault => {
    const urgent = fault.severity === "HIGH" || fault.type === "sensor failure";
    const hoursToAction = urgent ? 0 : Math.min(modelHours, fault.severity === "MEDIUM" ? 2 : 8);
    return {
      component: components[fault.type].component,
      urgency: urgent || hoursToAction === 0 ? "IMMEDIATE" as const : hoursToAction <= 2 ? "SCHEDULE" as const : "MONITOR" as const,
      hoursToAction,
      action: components[fault.type].action,
      evidence: `${fault.type} (${fault.severity.toLowerCase()}, confidence ${Math.round(fault.confidence * 100)}%); model RUL ${prediction.rul.toFixed(1)} h${unreliable ? "; estimate uncertain / verify sensors" : ""}.`,
    };
  });
  if (advisories.length === 0) advisories.push({
    component: "Engine health",
    urgency: modelHours <= 2 ? "SCHEDULE" : "MONITOR",
    hoursToAction: modelHours,
    action: modelHours <= 2 ? "Schedule an engine inspection; verify the model estimate against independent measurements." : "Continue monitoring; inspect at the next scheduled service.",
    evidence: `Model health ${prediction.health}/100; RUL ${prediction.rul.toFixed(1)} h${unreliable ? "; outside validated sensor range" : ""}.`,
  });
  return advisories.sort((a, b) => a.hoursToAction - b.hoursToAction);
}
