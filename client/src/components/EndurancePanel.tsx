import { useState } from "react";
import useSWR from "swr";
import { Activity, Clock3, RotateCcw, Square, TimerReset } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { roleGate, type DemoRole } from "@/lib/demoAuth";
import { RoleControl, RoleNotice, RoleSection } from "@/components/RoleAccess";
import type { EnduranceTrendPoint, StreamControls, TelemetrySnapshot } from "@/hooks/usePrognosticStream";

type SavedRun = { id: string; status: string; created_at: string; report_notes: string };
const fetchRuns = async (url: string): Promise<SavedRun[]> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load saved missions");
  return response.json();
};

export function EndurancePanel({ controls, telemetry, trend, activeId, onRunChange, role }: {
  role: DemoRole;
  controls: StreamControls;
  telemetry: TelemetrySnapshot;
  trend: EnduranceTrendPoint[];
  activeId: string | null;
  onRunChange: (id: string | null) => void;
}) {
  const opGate = roleGate(role, "Operator");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { data: runs, mutate } = useSWR("/api/endurance/runs", fetchRuns);
  const live = activeId !== null && telemetry.endurance?.id === activeId;
  const hours = live ? telemetry.endurance!.equivalentHours : 0;

  const stop = async (id: string) => {
    const response = await fetch(`/api/endurance/runs/${encodeURIComponent(id)}/stop`, { method: "POST" });
    if (!response.ok) throw new Error("Could not stop the current run");
  };
  const changeRun = async (reset: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (activeId) {
        await stop(activeId);
        onRunChange(null);
      }
      if (reset || !activeId) {
        const response = await fetch("/api/endurance/runs", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(controls),
        });
        if (!response.ok) throw new Error("Could not start the endurance mission");
        const run: { id: string } = await response.json();
        onRunChange(run.id);
      }
      await mutate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Mission request failed");
    } finally {
      setBusy(false);
    }
  };

  return <section className="endurance-panel" aria-label="Endurance mission simulation">
    <div className="endurance-heading"><span><Clock3 size={15} /> ENDURANCE MISSION</span><span className={`endurance-state ${activeId ? "active" : ""}`}>{activeId ? "WEAR SIMULATION LIVE" : "STANDBY"}</span></div>
    <p>Accelerate 24 equivalent flight hours into 3 real minutes. Gradual fleet-wide wear is separate from the cylinder-bias fault input.</p>
    <RoleNotice role={role} required="Operator" />
    <div className="endurance-actions">
      <RoleControl role={role} required="Operator"><button type="button" className="run-button" disabled={busy || role !== "Operator"} onClick={() => changeRun(true)} {...opGate}>{activeId ? <RotateCcw size={14} /> : <Activity size={14} />}{activeId ? "RESET / NEW RUN" : "START ENDURANCE"}</button></RoleControl>
      {activeId && <RoleControl role={role} required="Operator"><button type="button" className="endurance-stop" disabled={busy || role !== "Operator"} onClick={() => changeRun(false)} {...opGate}><Square size={12} /> STOP</button></RoleControl>}
    </div>
    {error && <p className="endurance-error" role="alert">{error}</p>}
    {activeId && <div className="endurance-readout" role="status"><div><span>EQUIVALENT FLIGHT TIME</span><strong>{hours.toFixed(1)} <small>h / 24 h wear profile</small></strong></div><TimerReset size={22} /><div className="endurance-track"><span style={{ width: `${Math.min(100, hours / 24 * 100)}%` }} /></div><small>Fixed RPM / MAP / altitude · cylinder bias suspended · sensors still pass through the standard detectors</small></div>}
    {activeId && <RoleSection role={role} required="Maintenance Engineer"><div className="endurance-trends">
      <div className="endurance-chart-head"><strong>HEALTH &amp; ANOMALY TREND</strong><span>health <i /> anomaly <b /></span></div>
      <div className="endurance-chart" aria-label="Live health and anomaly trend over equivalent flight hours" role="img">
        <ResponsiveContainer width="100%" height={125}><AreaChart data={trend} margin={{ top: 8, right: 7, bottom: 0, left: -30 }}><CartesianGrid vertical={false} stroke="#29393d" strokeDasharray="2 5" /><XAxis dataKey="hours" tickFormatter={(value: number) => `${value.toFixed(0)}h`} tick={{ fill: "#839a99", fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={20} /><YAxis domain={[0, 100]} tick={{ fill: "#839a99", fontSize: 9 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: "#172126", border: "1px solid #36494c", color: "#f4f7f2", fontSize: 11 }} labelFormatter={(value: number) => `${Number(value).toFixed(1)} equivalent hours`} formatter={(value: number, name: string) => [name === "anomalyPercent" ? `${Number(value).toFixed(0)}%` : `${value}/100`, name === "anomalyPercent" ? "Hybrid anomaly" : "Model health"]} /><Area dataKey="health" stroke="#b9f49a" fill="#b9f49a" fillOpacity={0.1} strokeWidth={2} isAnimationActive={false} /><Area dataKey="anomalyPercent" stroke="#f6b56e" fill="none" strokeWidth={2} isAnimationActive={false} /></AreaChart></ResponsiveContainer>
      </div>
      <div className="endurance-metrics"><span>OIL PRESSURE <b>{live ? telemetry.oilPressure.toFixed(1) : "—"} psi</b></span><span>VIBRATION <b>{live ? telemetry.vibration.toFixed(2) : "—"} mm/s</b></span><span>EGT RESIDUAL <b>{trend.length ? trend[trend.length - 1].egtResidual.toFixed(1) : "—"} °C</b></span></div>
      <span className="endurance-run-id">SQLITE MISSION · {activeId}</span>
    </div></RoleSection>}
    {runs && runs.length > 0 && <div className="endurance-saved"><span>SAVED ENDURANCE RUNS</span>{runs.slice(0, 3).map(run => <div key={run.id}><code>{run.id.slice(0, 12)}</code><small>{run.status} · {new Date(run.created_at).toLocaleString()}</small>{run.status === "ACTIVE" && !activeId && <RoleControl role={role} required="Operator"><button type="button" onClick={() => onRunChange(run.id)} {...opGate}>RESUME</button></RoleControl>}</div>)}</div>}
  </section>;
}
