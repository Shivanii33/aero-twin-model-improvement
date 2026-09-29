import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FlightLog } from "@/lib/flightLogStore";
import type { StreamControls } from "@/hooks/usePrognosticStream";

const presets = [
  { id: "high-altitude", label: "High Altitude", detail: "Climb to 15,500 ft" },
  { id: "endurance-mission", label: "Endurance Mission", detail: "24 equivalent hours" },
  { id: "hot-weather", label: "Hot-Weather Operation", detail: "38–48°C ambient" },
  { id: "rapid-throttle", label: "Rapid Throttle Transition", detail: "3,200 → 7,000 → 3,500 RPM" },
];

export function ScenarioPanel({ onRun, activeRun, role }: { onRun: (id: string, controls: StreamControls) => void; activeRun?: FlightLog; role: "Operator" | "Maintenance Engineer" }) {
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function run(id: string) {
    setRunning(id); setError("");
    try {
      const response = await fetch(`/api/scenarios/${id}`, { method: "POST" });
      if (!response.ok) throw new Error((await response.json()).error ?? "Scenario failed");
      const result = await response.json() as { id: string; controls: StreamControls };
      onRun(result.id, result.controls);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Scenario failed"); }
    finally { setRunning(null); }
  }
  const last = activeRun?.data.at(-1);
  return <section className="scenario-section" aria-labelledby="scenario-title">
    <div className="section-heading"><div><span className="section-label">SIMULATION / SCRIPTED MISSIONS</span><h2 id="scenario-title">Run a <em>scenario.</em></h2><p>Each preset runs a simulated profile and stores its samples in SQLite. Results appear below and in Mission replay.</p></div></div>
    <div className="scenario-presets">{presets.map(preset => <button type="button" className="panel scenario-preset" key={preset.id} disabled={running !== null} onClick={() => run(preset.id)}><strong>{preset.label}</strong><span>{running === preset.id ? "Running profile…" : preset.detail}</span><small>RUN PROFILE →</small></button>)}</div>
    {error && <p role="alert" className="evidence-notice">{error}</p>}
    {activeRun && last && <div className="panel scenario-result" role="status"><strong>{activeRun.mission} · completed</strong><span>{activeRun.sampleCount} stored samples · final health {last.health}/100 · RUL {last.rul} h · estimated SFC {last.sfc ?? "—"} g/kWh</span><span>{role === "Operator" ? "Flight view: review health and fuel use before planning recovery." : "Engineering view: inspect the residual trace and download the mission report for faults and recommendations."}</span></div>}
  </section>;
}

export function EfficiencyTrend({ run }: { run?: FlightLog }) {
  const points = run?.data.filter(point => point.sfc !== null) ?? [];
  return <article className="panel efficiency-panel" aria-labelledby="efficiency-title">
    <div className="panel-top"><span className="section-label">ENGINE EFFICIENCY / STORED HISTORY</span><span className="panel-code">ESTIMATED · NOT MEASURED SHAFT POWER</span></div>
    <div className="chart-title"><div><h3 id="efficiency-title">Specific fuel consumption trend</h3><p>Fuel flow × 0.74 kg/L ÷ estimated power. Power assumes 30 kW at 6,000 RPM and 1 bar MAP; compare relative changes only.</p></div></div>
    {points.length ? <ResponsiveContainer width="100%" height={230}><LineChart data={points} margin={{ top: 10, right: 22, bottom: 8, left: 6 }}><CartesianGrid vertical={false} stroke="#24353a" strokeDasharray="2 6"/><XAxis dataKey="label" tick={{ fill: "#8da29f", fontSize: 10 }} interval="preserveStartEnd"/><YAxis tick={{ fill: "#8da29f", fontSize: 10 }} width={55} unit="" domain={["auto", "auto"]}/><Tooltip contentStyle={{ background: "#172126", border: "1px solid #2b4145", color: "#f4f7f2" }} formatter={(value: number) => [`${value.toFixed(1)} g/kWh`, "Estimated SFC"]}/><Line type="monotone" dataKey="sfc" stroke="#b9f49a" strokeWidth={2} dot={false} isAnimationActive={false}/></LineChart></ResponsiveContainer> : <p className="empty-replay">No stored efficiency samples yet.</p>}
    <div className="chart-foot"><span>{run?.id ?? "No mission selected"}</span><span>{points.length} historical samples · g/kWh</span></div>
  </article>;
}
