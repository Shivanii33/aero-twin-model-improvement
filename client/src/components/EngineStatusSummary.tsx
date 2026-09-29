import { AlertCircle, CheckCircle2, Clock3, TriangleAlert } from "lucide-react";
import type { TelemetrySnapshot } from "@/hooks/usePrognosticStream";

type Props = {
  telemetry: TelemetrySnapshot;
  connection: "connecting" | "live" | "reconnecting";
  now: number;
};

export function EngineStatusSummary({ telemetry, connection, now }: Props) {
  const age = new Date(telemetry.ts).getTime();
  const ageSeconds = Number.isFinite(age) ? Math.max(0, Math.floor((now - age) / 1000)) : null;
  const fresh = connection === "live" && ageSeconds !== null && ageSeconds <= 5;
  const urgent = telemetry.faults.some(fault => fault.severity === "HIGH") || telemetry.advisories.some(advisory => advisory.urgency === "IMMEDIATE");
  const attention = telemetry.faults.length > 0 || telemetry.advisories.some(advisory => advisory.urgency === "SCHEDULE") || telemetry.anomaly > 0.46;
  const outOfRange = telemetry.outOfRangeFeatures.length > 0;
  const status = !fresh ? "Telemetry is not current" : urgent ? "Engine needs immediate attention" : attention || outOfRange ? "Engine needs a closer look" : "No active engine faults detected";
  const action = !fresh
    ? "Wait for the connection to recover. Verify readings before making a flight decision."
    : telemetry.advisories.find(advisory => advisory.urgency === "IMMEDIATE")?.action
      ?? (urgent ? "Review the active fault and follow the flight safety procedure." : outOfRange
        ? "Verify sensor readings independently before acting on model estimates."
        : telemetry.advisories.find(advisory => advisory.urgency === "SCHEDULE")?.action
          ?? (telemetry.faults.length ? "Review the active fault and monitor the engine trend." : "Continue monitoring the next live reading."));
  const evidence = !fresh
    ? "The values below are from the last received sample, not a live prediction."
    : `${telemetry.health}/100 model health · ${telemetry.rul.toFixed(1)} h estimated remaining life · ${telemetry.faults.length} active ${telemetry.faults.length === 1 ? "fault" : "faults"}${outOfRange ? ` · outside training range: ${telemetry.outOfRangeFeatures.join(", ")}` : ""}.`;
  const Icon = !fresh ? Clock3 : urgent ? AlertCircle : attention || outOfRange ? TriangleAlert : CheckCircle2;

  return <section id="section-overview" className={`engine-summary ${!fresh ? "is-stale" : urgent ? "is-critical" : attention || outOfRange ? "is-watch" : "is-ok"}`} aria-labelledby="engine-status-heading">
    <div className="summary-heading-row">
      <span className="summary-kicker">AP-04 / ENGINE STATUS</span>
      <span className="summary-sample" aria-live="polite">{ageSeconds === null ? "Sample time unavailable" : `Last update ${ageSeconds} s ago`}</span>
    </div>
    <div className="summary-status"><Icon aria-hidden="true" size={25} /><h1 id="engine-status-heading">{status}</h1></div>
    <div className="summary-details">
      <div><span>What should I do?</span><p>{action}</p></div>
      <div><span>Why?</span><p>{evidence}</p></div>
    </div>
    <p className="summary-caveat">Simulated telemetry and model estimates only. Follow approved procedures for operational decisions.</p>
  </section>;
}
