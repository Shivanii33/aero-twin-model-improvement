import React, { Suspense, useEffect, useMemo, useState } from "react";
import ErrorBoundary from "@/components/ErrorBoundary";
import { deriveEngineParts, type EnginePart } from "@/lib/engineTelemetry";
import type { EnginePartId } from "@/lib/engineParts";

const EngineViewport3D = React.lazy(() => import("@/components/EngineViewport3D"));
import useSWR from "swr";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BatteryCharging,
  Box,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleDot,
  Columns2,
  Expand,
  Gauge,
  History,
  Info,
  Layers3,
  LockKeyhole,
  Menu,
  Moon,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Compass,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  SkipBack,
  SkipForward,
  Sparkles,
  Thermometer,
  TimerReset,
  TriangleAlert,
  Sun,
  Wifi,
  X,
  Zap,
  Database,
  Download,
  MapPinned,
  ShieldAlert,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from "recharts";
import {
  StreamControls,
  TelemetrySnapshot,
  TelemetryPoint,
  EnduranceTrendPoint,
  usePrognosticStream,
} from "@/hooks/usePrognosticStream";
import ModelEvidence from "@/components/ModelEvidence";
import { MaintenanceAdvisory } from "@/components/MaintenanceAdvisory";
const Drone3D = React.lazy(() => import("@/components/Drone3D"));
import { EndurancePanel } from "@/components/EndurancePanel";
import { RoleControl, RoleNotice, RoleSection } from "@/components/RoleAccess";
import { Link } from "wouter";
import { initials, roleGate, useDemoAuth, type DemoRole } from "@/lib/demoAuth";
import { FlightLog, getLastReplayId, getThemePreference, saveLastReplayId, saveThemePreference } from "@/lib/flightLogStore";
import { fetchReplayRuns } from "@/lib/replayApi";
import { ScenarioPanel, EfficiencyTrend } from "@/components/ScenarioPanel";
import { EngineStatusSummary } from "@/components/EngineStatusSummary";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

const navItems = [
  { label: "Overview", icon: Gauge, target: "section-overview" },
  { label: "Telemetry", icon: Radio, target: "section-telemetry" },
  {
    label: "Diagnostics",
    icon: TriangleAlert,
    target: "section-diagnostics",
  },
  {
    label: "Mission replay",
    icon: RotateCcw,
    target: "section-mission-replay",
  },
  { label: "Maintenance", icon: TimerReset, target: "section-maintenance" },
];

function SectionLabel({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {right}
    </div>
  );
}

function StatusPill({
  children,
  tone = "mint",
}: {
  children: React.ReactNode;
  tone?: "mint" | "amber" | "rose" | "slate" | "violet";
}) {
  return (
    <span className={`status-pill ${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}

function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="info-tooltip" tabIndex={0} aria-label={text}>
      <Info size={12} />
      <span className="tooltip-popover">{text}</span>
    </span>
  );
}

function MetricLabel({ label, meaning }: { label: string; meaning: string }) {
  return <span>{label} <InfoTooltip text={`What this means: ${meaning}`} /></span>;
}

type LandingZone = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  densityScore: number;
  distanceM: number;
};

function MissionPlanner({
  telemetry,
  missionId,
  role,
}: {
  telemetry: any;
  missionId: string;
  role: DemoRole;
}) {
  const opGate = roleGate(role, "Operator");
  const [mode, setMode] = useState<"RTB" | "EMERGENCY LANDING">("RTB");
  const [saved, setSaved] = useState(false);
  const {
    data: zones,
    error: zonesError,
    isLoading: zonesLoading,
  } = useSWR<LandingZone[]>("/api/landing-zones", async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Unable to load landing zones");
    return response.json();
  });
  const recommendedZone = zones?.[0];
  const recommendedLabel = recommendedZone
    ? `${recommendedZone.id} · ${recommendedZone.name}`
    : zonesError
      ? "Zone data unavailable"
      : zonesLoading
        ? "Evaluating zones…"
        : "No zones within safe radius";
  const landing = mode === "RTB" ? "Launch base · 4.8 km" : recommendedLabel;
  const createMission = async () => {
    try {
      const response = await fetch(`/api/missions/${encodeURIComponent(missionId)}/decision`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: mode, landingMode: landing }),
      });
      setSaved(response.ok);
      if (response.ok) toast.success("Mission decision saved");
      else toast.error("Could not save decision. Check the connection and try again.");
    } catch {
      setSaved(false);
      toast.error("Connection lost. Reconnect and try saving again.");
    }
  };
  return (
    <section id="section-maintenance" className="mission-section">
      <div className="section-heading">
        <div>
          <SectionLabel>
            <MapPinned size={14} /> 08 / MISSION SAFETY PLANNER
          </SectionLabel>
          <h2>
            Fly the <em>safe route.</em>
          </h2>
          <p>3D airspace view with RTB and emergency landing logic.</p>
        </div>
        <a className="run-button" href={`/api/reports/${encodeURIComponent(missionId)}`} download={`aerotwin-${missionId}.pdf`}>
          <Download size={14} /> DOWNLOAD HEALTH REPORT PDF
        </a>
      </div>
      <div className="mission-grid">
        <article className="panel mission-map">
          <div className="map-sky">
            <div className="map-grid" />
            <div className="flight-path" />
            <div className="drone-3d-canvas">
<Suspense fallback={<Skeleton className="h-full w-full" />}>
                  <Drone3D mode={mode} hasFault={telemetry.faults.length > 0} anomaly={telemetry.anomaly} />
                </Suspense>
            </div>
            <div className="base-marker">BASE</div>
            <div className="landing-marker">
              {recommendedZone ? (
                <>
                  {recommendedZone.id}
                  <br />
                  <small>{recommendedZone.name}</small>
                </>
              ) : (
                <small>
                  {zonesError
                    ? "ZONE DATA UNAVAILABLE"
                    : zonesLoading
                      ? "EVALUATING ZONES"
                      : "NO SAFE ZONE"}
                </small>
              )}
            </div>
            <div className="safe-radius" />
          </div>
          <div className="map-legend">
            <span>
              <i className="legend-drone" /> aircraft
            </span>
            <span>
              <i className="legend-route" /> planned route
            </span>
            <span>
              <i className="legend-safe" /> safe radius
            </span>
            <span>
              <i className="legend-land" /> least-populated landing
            </span>
          </div>
          <div
            className="map-legend"
            aria-label="Other candidate landing zones"
          >
            <span>OTHER ZONES · DEMO DENSITY PROXY / 100</span>
            {zones?.slice(1).map(zone => (
              <span key={zone.id}>
                {zone.id} {zone.name} · {zone.densityScore}/100 ·{" "}
                {(zone.distanceM / 1000).toFixed(1)} km
              </span>
            ))}
          </div>
        </article>
        <article className="panel mission-control">
          <div className="panel-top">
            <SectionLabel>
              <ShieldAlert size={14} /> FLIGHT DECISION
            </SectionLabel>
            <StatusPill tone={mode === "RTB" ? "mint" : "amber"}>
              {mode}
            </StatusPill>
          </div>
          <div className="decision-copy">
            <span className="eyebrow">TRIGGER CONDITION</span>
            <strong>
              {telemetry.anomaly > 0.55
                ? "ENGINE HEALTH DEGRADATION"
                : "OPERATOR SELECTED CONTINGENCY"}
            </strong>
            <p>
              Logic selects a safe-radius corridor first, then the
              least-populated landing zone from the mission grid.
            </p>
          </div>
          <RoleNotice role={role} required="Operator" />
          <div className="decision-buttons">
            <RoleControl role={role} required="Operator"><button
              className={mode === "RTB" ? "selected" : ""}
              onClick={() => { setMode("RTB"); setSaved(false); toast.info("Return to base selected. Save to confirm this decision."); }}
              {...opGate}
            >
              RETURN TO BASE <small>nominal recovery</small>
            </button></RoleControl>
            <RoleControl role={role} required="Operator"><button
              className={
                mode === "EMERGENCY LANDING" ? "selected emergency" : ""
              }
              onClick={() => { setMode("EMERGENCY LANDING"); setSaved(false); toast.info("Emergency landing selected. Save to confirm this decision."); }}
              {...opGate}
            >
              EMERGENCY LANDING <small>least-populated area</small>
            </button></RoleControl>
          </div>
          <div className="decision-readout">
            <span>RECOMMENDED ZONE</span>
            <strong>{recommendedLabel}</strong>
            <span>SAFE RADIUS</span>
            <strong>5 km · candidate search radius</strong>
          </div>
          <RoleControl role={role} required="Operator"><button className="run-button mission-save" onClick={createMission} disabled={missionId === "UNASSIGNED"} {...opGate}>
            {missionId === "UNASSIGNED" ? "UNASSIGNED HISTORY · NO MISSION DECISION" : saved ? "MISSION DECISION PERSISTED" : "SAVE MISSION DECISION"}
          </button></RoleControl>
        </article>
      </div>
    </section>
  );
}

function ReplayComparisonCard({
  run,
  runs,
  cursor,
  onSelect,
  accent,
}: {
  run: FlightLog;
  runs: FlightLog[];
  cursor: number;
  onSelect: (value: number) => void;
  accent: "mint" | "violet";
}) {
  const point = run.data[cursor] ?? run.data[run.data.length - 1];
  return (
    <article className={`comparison-card ${accent}`}>
      <div className="comparison-card-head">
        <div>
          <span className="comparison-kicker">
            {accent === "mint" ? "SELECTED STORED RUN" : "COMPARISON STORED RUN"}
          </span>
          <strong>{run.id}</strong>
        </div>
        <select
          aria-label={`${accent} comparison run`}
          value={runs.findIndex(item => item.id === run.id)}
          onChange={event => onSelect(Number(event.target.value))}
        >
          {runs.map((item, index) => (
            <option key={item.id} value={index}>
              {item.id} · {item.mission}
            </option>
          ))}
        </select>
      </div>
      <div className="comparison-mission">
        <span>{run.mission}</span>
        <b>{run.date}</b>
      </div>
      <div className="comparison-chart">
        <ResponsiveContainer width="100%" height={190}>
          <ComposedChart
            data={run.data}
            margin={{ top: 10, right: 8, bottom: 3, left: -20 }}
          >
            <CartesianGrid
              vertical={false}
              stroke="#24353a"
              strokeDasharray="2 6"
            />
            <XAxis
              dataKey="label"
              tick={{ fill: "var(--text-secondary)", fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              interval={5}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fill: "var(--text-secondary)", fontSize: 9 }}
              axisLine={false}
              tickLine={false}
            />
            <ReferenceLine
              x={point.label}
              stroke={accent === "mint" ? "var(--brand-accent)" : "#c4b7ff"}
              strokeDasharray="3 3"
              strokeOpacity={0.9}
            />
            <Tooltip
              contentStyle={{
                background: "#172126",
                border: "1px solid #2b4145",
                borderRadius: 8,
                color: "#f4f7f2",
                fontSize: 11,
              }}
              formatter={(value: number, name: string) => [
                name === "residual"
                  ? `${value.toFixed(1)} Δ`
                  : `${value.toFixed(1)} °C`,
                name === "actual"
                  ? "Measured"
                  : name === "baseline"
                    ? "Baseline"
                    : "Residual",
              ]}
            />
            <Line
              type="monotone"
              dataKey="actual"
              stroke={accent === "mint" ? "var(--status-watch)" : "#b8a7ff"}
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="baseline"
              stroke="#8ba8a5"
              strokeWidth={1.3}
              strokeDasharray="5 5"
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="residual"
              stroke={accent === "mint" ? "var(--brand-accent)" : "#c4b7ff"}
              strokeWidth={1.6}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="comparison-readout">
        <span>
          CURSOR <b>{point.label}</b>
        </span>
        <span>
          EGT <b>{point.actual.toFixed(1)}°C</b>
        </span>
        <span>
          Δ <b>{point.residual.toFixed(1)}</b>
        </span>
      </div>
    </article>
  );
}

function StatTile({
  label,
  value,
  unit,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  unit: string;
  icon: typeof Gauge;
  tone: string;
}) {
  const explanations: Record<string, string> = {
    "ENGINE HEALTH": "What this means: model-estimated engine condition on a 0–100 scale; not a certified safety rating.",
    "EST. REMAINING LIFE": "What this means: RUL (remaining useful life) is a model estimate, not a service interval.",
    "MODEL CONFIDENCE": "What this means: a heuristic for this model estimate, not the probability of a safe flight.",
    "HYBRID ANOMALY": "What this means: combined sensor and physics-model deviation; higher values warrant investigation.",
  };
  return (
    <div className="stat-tile">
      <div className={`icon-box ${tone}`}>
        <Icon size={16} strokeWidth={1.8} />
      </div>
      <div>
        <div className="eyebrow">{label} <InfoTooltip text={explanations[label] ?? `What this means: ${label.toLowerCase()} from the latest model sample.`} /></div>
        <div className="stat-value">
          {value}
          <span>{unit}</span>
        </div>
      </div>
      <ArrowUpRight className="stat-arrow" size={15} />
    </div>
  );
}

function CircularHealth({
  health,
  anomaly,
}: {
  health: number;
  anomaly: number;
}) {
  const rotation = Math.round(health * 3.6);
  return (
    <div
      className="health-ring"
      style={{
        background: `conic-gradient(var(--brand-accent) 0deg ${rotation}deg, var(--surface-raised) ${rotation}deg 360deg)`,
      }}
    >
      <div className="health-ring-inner">
        <span className="health-number">{health}</span>
        <span className="health-caption">HEALTH / 100</span>
      </div>
      <div
        className="ring-marker"
        style={{ transform: `rotate(${rotation - 90}deg)` }}
      />
      <div className="ring-anomaly">
        <span>ANOMALY</span>
        <strong>{anomaly.toFixed(2)}</strong>
      </div>
    </div>
  );
}

function ControlSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  hint: string;
}) {
  const progress = ((value - min) / (max - min)) * 100;
  return (
    <label className="control-row">
      <span className="control-top">
        <span>{label}</span>
        <strong>
          {value.toLocaleString()} <em>{unit}</em>
        </strong>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        style={{
          background: `linear-gradient(90deg, var(--brand-accent) ${progress}%, var(--surface-raised) ${progress}%)`,
        }}
      />
      <span className="control-foot">
        <span>{hint}</span>
        <span>
          {min.toLocaleString()} — {max.toLocaleString()}
        </span>
      </span>
    </label>
  );
}


type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
};
type ChatScope = "component" | "all";

const CHAT_TRANSCRIPT_KEY = "aerotwin.diagnostic-chat.v1";
type TranscriptStore = Record<string, ChatMessage[]>;

function readTranscriptStore(): TranscriptStore {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(CHAT_TRANSCRIPT_KEY);
    return stored ? (JSON.parse(stored) as TranscriptStore) : {};
  } catch {
    return {};
  }
}

function loadChatTranscript(partId: string): ChatMessage[] {
  const messages = readTranscriptStore()[partId];
  return Array.isArray(messages)
    ? messages.map(message => ({
        ...message,
        timestamp: message.timestamp ?? new Date().toISOString(),
      }))
    : [];
}

function saveChatTranscript(partId: string, messages: ChatMessage[]) {
  if (typeof window === "undefined") return;
  try {
    const transcripts = readTranscriptStore();
    window.localStorage.setItem(
      CHAT_TRANSCRIPT_KEY,
      JSON.stringify({ ...transcripts, [partId]: messages.slice(-24) })
    );
  } catch {
    // Local storage can be unavailable in private browsing; the in-memory chat still works.
  }
}

function formatChatDate(timestamp?: string) {
  if (!timestamp) return "undated";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

function answerDiagnosticQuestion(part: EnginePart, question: string) {
  if (part.state === "NO SENSOR") return "No live sensor for this part";
  if (part.state === "UNAVAILABLE") return `No live reading is available for ${part.label}.`;
  const normalized = question.toLowerCase();
  if (
    normalized.includes("maint") ||
    normalized.includes("fix") ||
    normalized.includes("action")
  ) {
    return part.state === "CRITICAL"
      ? `Maintenance priority is immediate for ${part.label}. Isolate the asset, validate the ${part.metric.toLowerCase()} with an independent measurement, and inspect the associated circuit before release.`
      : part.state === "WATCH"
        ? `${part.label} is a watch item. Schedule a targeted inspection, verify the sensor and connections, and compare the next two high-load samples before escalating.`
        : `${part.label} is nominal. No immediate maintenance action is indicated; retain the current baseline and review it after the next mission.`;
  }
  if (
    normalized.includes("why") ||
    normalized.includes("cause") ||
    normalized.includes("trend")
  ) {
    return `${part.label} is currently ${part.state.toLowerCase()} because its ${part.metric.toLowerCase()} reads ${part.value} against a safe range of ${part.safe}. The recent history shows: ${part.history[0]}.`;
  }
  return `I’m tracking ${part.label} at ${part.value}. Its current status is ${part.state.toLowerCase()} against ${part.safe}. Ask me about the cause, trend, or recommended maintenance action for a more focused answer.`;
}

function getAiDiagnosticSummary(part: EnginePart) {
  if (part.state === "NO SENSOR") return { summary: "No live sensor for this part", actions: ["Inspect the part using the maintenance record; no sensor-based conclusion is available."] };
  if (part.state === "UNAVAILABLE") return { summary: `No live reading is available for ${part.label}.`, actions: ["Wait for a fresh telemetry sample before interpreting its health."] };
  const critical = part.state === "CRITICAL";
  const watch = part.state === "WATCH";
  const summary = critical
    ? `${part.label} is outside its safe operating envelope. The current ${part.metric.toLowerCase()} reading of ${part.value} aligns with the highest-severity events in the recent history and should be treated as an immediate maintenance gate.`
    : watch
      ? `${part.label} is showing an emerging deviation. The ${part.metric.toLowerCase()} reading of ${part.value} is approaching or exceeding the preferred envelope, matching the trend seen in the recent run history.`
      : `${part.label} is operating within the current safe envelope at ${part.value}. Recent run history shows no active critical trend, but continued sampling is recommended during the next mission.`;
  const actions = critical
    ? [
        "Ground the asset for a targeted inspection before the next sortie.",
        "Validate the sensor and compare against an independent calibrated measurement.",
        "Open a maintenance record and review the last two mission traces.",
      ]
    : watch
      ? [
          "Increase sampling attention for this component during the next replay.",
          "Inspect the related sensor, connector, and cooling or lubrication path.",
          "Schedule a preventive check if the deviation persists for two consecutive runs.",
        ]
      : [
          "Continue 1-second telemetry sampling and retain the current baseline.",
          "Review this component again after the next high-load or high-altitude run.",
          "No immediate maintenance gate is recommended from the current evidence.",
        ];
  return { summary, actions };
}

function EngineTwin3D({
  telemetry,
  controls,
  connection,
  role,
}: {
  telemetry: TelemetrySnapshot;
  controls: StreamControls;
  connection: "connecting" | "live" | "reconnecting";
  role: DemoRole;
}) {
  const engGate = roleGate(role, "Maintenance Engineer");
  const [exploded, setExploded] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState<EnginePartId | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [chatScope, setChatScope] = useState<ChatScope>("component");
  const [chatFrom, setChatFrom] = useState("");
  const [chatTo, setChatTo] = useState("");
  const [chatPreset, setChatPreset] = useState<"none" | "critical" | "last30">(
    "none"
  );
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const parts = useMemo(() => deriveEngineParts(telemetry, controls), [telemetry, controls]);
  const selectedPart = parts.find(part => part.id === selectedPartId) ?? null;
  const getPart = (id: EnginePartId) => parts.find(part => part.id === id)!;
  const cylinders = parts.filter(part => part.id.startsWith("cyl-")).map(part => ({
    id: Number(part.id.slice(-1)), cht: telemetry.cht[Number(part.id.slice(-1)) - 1],
    egt: telemetry.egt[Number(part.id.slice(-1)) - 1], state: part.state,
  }));
  const partState = (state: EnginePart["state"]) => state === "CRITICAL" ? "critical" : state === "WATCH" ? "watch" : "nominal";
  const warningCount = parts.filter(part => part.state === "WATCH" || part.state === "CRITICAL").length;
  const oilCritical = getPart("crankcase").state === "CRITICAL";
  const tempCritical = getPart("oil").state === "CRITICAL";
  const aiSummary = selectedPart ? getAiDiagnosticSummary(selectedPart) : null;
  const allTranscriptResults = useMemo(() => {
    const query = chatSearch.trim().toLowerCase();
    const presetFrom =
      chatPreset === "last30"
        ? Date.now() - 30 * 24 * 60 * 60 * 1000
        : -Infinity;
    const from = chatFrom
      ? new Date(`${chatFrom}T00:00:00`).getTime()
      : presetFrom;
    const to = chatTo ? new Date(`${chatTo}T23:59:59`).getTime() : Infinity;
    const store = readTranscriptStore();
    return Object.entries(store).flatMap(([partId, messages]) =>
      messages
        .filter(message => {
          const timestamp = message.timestamp
            ? new Date(message.timestamp).getTime()
            : Date.now();
          const criticalMatch =
            /critical|immediate|outside.*safe|ground.*asset|maintenance gate/i.test(
              message.text
            );
          return (
            (!query || message.text.toLowerCase().includes(query)) &&
            (!chatPreset || chatPreset === "last30" || criticalMatch) &&
            timestamp >= from &&
            timestamp <= to
          );
        })
        .map(message => ({ ...message, partId }))
    );
  }, [chatMessages, chatSearch, chatFrom, chatPreset, chatTo]);
  const visibleMessages = useMemo(() => {
    if (chatScope === "all") return allTranscriptResults;
    const query = chatSearch.trim().toLowerCase();
    const presetFrom =
      chatPreset === "last30"
        ? Date.now() - 30 * 24 * 60 * 60 * 1000
        : -Infinity;
    const from = chatFrom
      ? new Date(`${chatFrom}T00:00:00`).getTime()
      : presetFrom;
    const to = chatTo ? new Date(`${chatTo}T23:59:59`).getTime() : Infinity;
    return chatMessages.filter(message => {
      const timestamp = message.timestamp
        ? new Date(message.timestamp).getTime()
        : Date.now();
      const criticalMatch =
        /critical|immediate|outside.*safe|ground.*asset|maintenance gate/i.test(
          message.text
        );
      return (
        (!query || message.text.toLowerCase().includes(query)) &&
        (!chatPreset || chatPreset === "last30" || criticalMatch) &&
        timestamp >= from &&
        timestamp <= to
      );
    });
  }, [
    allTranscriptResults,
    chatMessages,
    chatFrom,
    chatPreset,
    chatScope,
    chatSearch,
    chatTo,
    selectedPart?.id,
  ]);
  const quickPrompts = selectedPart
    ? [
        `Why is ${selectedPart.label} ${selectedPart.state.toLowerCase()}?`,
        "What maintenance action should I take?",
        "What trend should I watch next?",
      ]
    : [];
  const askQuestion = (question: string) => {
    const cleanQuestion = question.trim();
    if (!cleanQuestion || !selectedPart) return;
    const timestamp = new Date().toISOString();
    const nextMessages: ChatMessage[] = [
      ...chatMessages,
      { role: "user", text: cleanQuestion, timestamp },
      {
        role: "assistant",
        text: answerDiagnosticQuestion(selectedPart, cleanQuestion),
        timestamp,
      },
    ];
    setChatMessages(nextMessages);
    saveChatTranscript(selectedPart.id, nextMessages);
    setChatDraft("");
  };
  useEffect(() => {
    if (selectedPart) {
      setChatDraft("");
      setChatSearch("");
      setChatScope("component");
      setChatFrom("");
      setChatTo("");
      setChatPreset("none");
      const storedMessages = loadChatTranscript(selectedPart.id);
      const initialMessage: ChatMessage = {
        role: "assistant",
        text: selectedPart.state === "NO SENSOR" ? `I’m ready to answer questions about ${selectedPart.label}. No live sensor for this part` : `I’m ready to answer questions about ${selectedPart.label}. Current status: ${selectedPart.state.toLowerCase()} at ${selectedPart.value}.`,
        timestamp: new Date().toISOString(),
      };
      const messages = storedMessages.length
        ? storedMessages
        : [initialMessage];
      setChatMessages(messages);
      if (!storedMessages.length) saveChatTranscript(selectedPart.id, messages);
    }
  }, [selectedPart?.id]);
  return (
    <section className="engine-twin-section">
      <div className="engine-twin-heading">
        <div>
          <SectionLabel>
            <Box size={14} /> 03 / ENGINE TWIN / 3D INSPECTION
          </SectionLabel>
          <h2>
            Inspect the machine <em>as it is.</em>
          </h2>
          <p>
            Click a component for diagnostics (Engineer). Explode the replica to inspect
            its internal telemetry map.
          </p>
        </div>
        <div className="engine-heading-actions">
          <RoleControl role={role} required="Maintenance Engineer">
            <button
              type="button"
              className={`engine-toggle ${exploded ? "active" : ""}`}
              onClick={() => setExploded(value => !value)}
              {...engGate}
            >
              <Expand size={14} /> {exploded ? "COLLAPSE VIEW" : "EXPLODE VIEW"}
            </button>
          </RoleControl>
          <StatusPill tone={warningCount > 0 ? "amber" : "mint"}>
            <span className="status-dot" />{" "}
            {warningCount > 0 ? `${warningCount} WARNINGS` : "ALL NOMINAL"}
          </StatusPill>
        </div>
      </div>
      <div className="engine-twin-grid">
        <ErrorBoundary>
          <Suspense fallback={<div className="panel twin-viewport twin-loading" role="status" aria-label="Loading engine view"><Skeleton className="twin-canvas-wrap" /><Skeleton /><Skeleton /></div>}>
            <EngineViewport3D telemetry={telemetry} controls={controls} connection={connection} selectedPartId={selectedPartId} onSelectPart={setSelectedPartId} exploded={exploded} role={role} />
          </Suspense>
        </ErrorBoundary>
        <div className="panel engine-readouts">
          <div className="panel-top">
            <SectionLabel>
              <Activity size={14} /> LIVE ENGINE VALUES
            </SectionLabel>
            <span className="panel-code">SAMPLE / 1 SEC</span>
          </div>
          <div className="engine-value-grid">
            <div
              className={`engine-value ${oilCritical ? "danger-value" : ""}`}
            >
              <span>RPM / CRANK SPEED</span>
              <strong>
                {controls.rpm.toLocaleString()}
                <small>rpm</small>
              </strong>
              <b className="value-bar">
                <i style={{ width: `${Math.min(100, controls.rpm / 72)}%` }} />
              </b>
            </div>
            <div className="engine-value">
              <span>MAP / LOAD</span>
              <strong>
                {controls.map.toFixed(2)}
                <small>bar</small>
              </strong>
              <b className="value-bar violet">
                <i
                  style={{
                    width: `${Math.min(100, (controls.map / 1.08) * 100)}%`,
                  }}
                />
              </b>
            </div>
            <div
              className={`engine-value ${oilCritical ? "danger-value" : ""}`}
            >
              <span>OIL PRESSURE</span>
              <strong>
                {telemetry.oilPressure}
                <small>psi</small>
              </strong>
              <b className="value-bar amber">
                <i
                  style={{
                    width: `${Math.min(100, (telemetry.oilPressure / 35) * 100)}%`,
                  }}
                />
              </b>
            </div>
            <div
              className={`engine-value ${tempCritical ? "danger-value" : ""}`}
            >
              <span>OIL TEMPERATURE</span>
              <strong>
                {telemetry.oilTemp}
                <small>°C</small>
              </strong>
              <b className="value-bar cyan">
                <i
                  style={{
                    width: `${Math.min(100, (telemetry.oilTemp / 130) * 100)}%`,
                  }}
                />
              </b>
            </div>
          </div>
          <div className="cylinder-readouts">
            {cylinders.map(cylinder => (
              <button
                type="button"
                className={`cylinder-readout ${partState(cylinder.state as EnginePart["state"])}`}
                key={cylinder.id}
                onClick={() =>
                  setSelectedPartId(`cyl-${cylinder.id}` as EnginePartId)
                }
                {...engGate}
              >
                <div>
                  <span>CYL {cylinder.id}</span>
                  <StatusPill
                    tone={
                      cylinder.state === "CRITICAL"
                        ? "rose"
                        : cylinder.state === "WATCH"
                          ? "amber"
                          : "mint"
                    }
                  >
                    {cylinder.state}
                  </StatusPill>
                </div>
                <div>
                  <strong>
                    {cylinder.cht}
                    <small>°C CHT</small>
                  </strong>
                  <strong>
                    {cylinder.egt}
                    <small>°C EGT</small>
                  </strong>
                </div>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
          <div className="engine-readout-note">
            <Check size={13} /> Telemetry mapped to geometry · click a row for
            fault history
          </div>
        </div>
      </div>
      {selectedPart && (
        <div
          className="diagnostic-overlay"
          role="presentation"
          onClick={() => setSelectedPartId(null)}
        >
          <div
            className="diagnostic-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="diagnostic-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="diagnostic-modal-top">
              <div>
                <span className="eyebrow">
                  PART DIAGNOSTIC / {selectedPart.id.toUpperCase()}
                </span>
                <h3 id="diagnostic-title">{selectedPart.label}</h3>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label="Close diagnostic modal"
                onClick={() => setSelectedPartId(null)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="diagnostic-status-row">
              <StatusPill
                tone={
                  selectedPart.state === "CRITICAL"
                    ? "rose"
                    : selectedPart.state === "WATCH"
                      ? "amber"
                      : "mint"
                }
              >
                {selectedPart.state}
              </StatusPill>
              <span>
                {selectedPart.state === "NO SENSOR" ? "No live sensor for this part" : <>live value <b>{selectedPart.value}</b></>}
              </span>
              <span>
                safe range <b>{selectedPart.safe}</b>
              </span>
            </div>
            <div className="ai-summary-card">
              <div className="ai-summary-heading">
                <Sparkles size={15} />
                <span>AI DIAGNOSTIC SUMMARY</span>
                <b>EXPLAINABLE / LOCAL</b>
              </div>
              <p>{aiSummary?.summary}</p>
              <div className="prediction-explanations">
                <strong>LIVE HEALTH / RUL DRIVERS</strong>
                <p>{telemetry.explanations.method}</p>
                {(["health", "rul"] as const).map(target => <div key={target} className="explanation-group"><b>{target === "health" ? "Health index" : "RUL hours"}</b><ul>{telemetry.explanations[target].map(item => <li key={item.feature}><span>{item.feature.replaceAll("_", " ")}</span><strong>{item.delta >= 0 ? "+" : ""}{item.delta.toFixed(target === "health" ? 3 : 2)}</strong><small>vs median {item.reference.toFixed(1)}</small></li>)}</ul></div>)}
              </div>
              <div className="maintenance-actions">
                <span>RECOMMENDED MAINTENANCE ACTIONS</span>
                {aiSummary?.actions.map(action => (
                  <div className="maintenance-action" key={action}>
                    <Check size={13} />
                    {action}
                  </div>
                ))}
              </div>
            </div>
            <div className="diagnostic-detail">
              <div className="diagnostic-metric">
                <span>{selectedPart.metric}</span>
                <strong>{selectedPart.value}</strong>
                <div
                  className={`diagnostic-meter ${selectedPart.state.toLowerCase()}`}
                >
                  <i />
                </div>
              </div>
              <div className="fault-history">
                <div className="fault-history-title">
                  <span>FAULT HISTORY</span>
                  <span>LAST 3 RUNS</span>
                </div>
                {selectedPart.history.map(event => (
                  <div className="fault-event" key={event}>
                    <span className="history-dot" />
                    {event}
                  </div>
                ))}
              </div>
            </div>
            <div className="diagnostic-chat">
              <div className="diagnostic-chat-head">
                <div>
                  <Sparkles size={14} />
                  <span>ASK THE AI ABOUT THIS COMPONENT</span>
                </div>
                <b>LOCAL EXPLAINABLE ASSISTANT</b>
              </div>
              <label className="chat-history-search">
                <Search size={13} />
                <input
                  value={chatSearch}
                  onChange={event => setChatSearch(event.target.value)}
                  placeholder="Search past discussions..."
                  aria-label="Search diagnostic chat history"
                />
                {chatSearch && (
                  <button
                    type="button"
                    onClick={() => setChatSearch("")}
                    aria-label="Clear chat search"
                  >
                    ×
                  </button>
                )}
              </label>
              <div className="chat-presets">
                <span>QUICK FILTERS</span>
                <button
                  type="button"
                  className={chatPreset === "critical" ? "active" : ""}
                  onClick={() => {
                    setChatPreset("critical");
                    setChatFrom("");
                    setChatTo("");
                  }}
                >
                  CRITICAL EVENTS
                </button>
                <button
                  type="button"
                  className={chatPreset === "last30" ? "active" : ""}
                  onClick={() => {
                    setChatPreset("last30");
                    setChatFrom("");
                    setChatTo("");
                  }}
                >
                  LAST 30 DAYS
                </button>
                <button
                  type="button"
                  className="clear"
                  onClick={() => {
                    setChatPreset("none");
                    setChatSearch("");
                    setChatFrom("");
                    setChatTo("");
                  }}
                >
                  CLEAR
                </button>
              </div>
              <div className="chat-filter-row">
                <select
                  value={chatScope}
                  onChange={event =>
                    setChatScope(event.target.value as ChatScope)
                  }
                  aria-label="Chat history scope"
                >
                  <option value="component">This component</option>
                  <option value="all">All components</option>
                </select>
                <label>
                  FROM{" "}
                  <input
                    type="date"
                    value={chatFrom}
                    onChange={event => setChatFrom(event.target.value)}
                  />
                </label>
                <label>
                  TO{" "}
                  <input
                    type="date"
                    value={chatTo}
                    onChange={event => setChatTo(event.target.value)}
                  />
                </label>
              </div>
              <div className="chat-suggestions">
                {quickPrompts.map(prompt => (
                  <button
                    type="button"
                    key={prompt}
                    onClick={() => askQuestion(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
              <div className="chat-thread">
                {visibleMessages.length ? (
                  visibleMessages.map((message, index) => (
                    <div
                      className={`chat-message ${message.role}`}
                      key={`${message.role}-${index}`}
                    >
                      <span>{message.role === "assistant" ? "AI" : "YOU"}</span>
                      <p>
                        {chatScope === "all" && "partId" in message ? (
                          <>
                            <b className="chat-result-part">
                              {parts.find(
                                part => part.id === String(message.partId)
                              )?.label ?? String(message.partId)}{" "}
                              · {formatChatDate(message.timestamp)}
                            </b>
                            {message.text}
                          </>
                        ) : (
                          <>
                            {message.text}
                            <small className="chat-message-date">
                              {formatChatDate(message.timestamp)}
                            </small>
                          </>
                        )}
                      </p>
                    </div>
                  ))
                ) : (
                  <div className="chat-empty">
                    No matching discussion in this component history.
                  </div>
                )}
              </div>
              <form
                className="chat-form"
                onSubmit={event => {
                  event.preventDefault();
                  askQuestion(chatDraft);
                }}
              >
                <input
                  value={chatDraft}
                  onChange={event => setChatDraft(event.target.value)}
                  placeholder="e.g. Why is this part on watch?"
                  aria-label="Ask the component AI assistant"
                />
                <button type="submit" aria-label="Ask AI">
                  <Send size={14} /> ASK
                </button>
              </form>
            </div>
            <div className="diagnostic-modal-foot">
              <span>
                <Check size={13} /> component telemetry mapped
              </span>
              <button
                type="button"
                className="run-button"
                onClick={() => setSelectedPartId(null)}
              >
                CLOSE INSPECTION <ChevronRight size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function AttentionHeatmap({
  data,
  cursor,
}: {
  data: { time: number; head: number; weight: number }[];
  cursor: number;
}) {
  return (
    <div className="heatmap-wrap">
      <ResponsiveContainer width="100%" height={170}>
        <ScatterChart margin={{ top: 8, right: 4, bottom: 4, left: -22 }}>
          <XAxis
            type="number"
            dataKey="time"
            domain={[0, Math.max(...data.map(point => point.time))]}
            tickCount={5}
            tick={{ fill: "var(--text-secondary)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="number"
            dataKey="head"
            domain={[0, 7]}
            tickCount={4}
            tick={{ fill: "var(--text-secondary)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <ReferenceLine
            x={cursor}
            stroke="#ffffff"
            strokeDasharray="3 3"
            strokeOpacity={0.65}
            label={{
              value: "REPLAY CURSOR",
              fill: "#c7d8cb",
              fontSize: 9,
              position: "insideTopRight",
            }}
          />
          <Tooltip
            cursor={{ stroke: "#9bb4ad", strokeDasharray: "3 3" }}
            contentStyle={{
              background: "#172126",
              border: "1px solid #2b4145",
              borderRadius: 8,
              color: "#f4f7f2",
              fontSize: 12,
            }}
            formatter={(value: number) => [
              `${value.toFixed(2)}`,
              "attention weight",
            ]}
          />
          <Scatter
            data={data}
            fill="var(--brand-accent)"
            shape={(props: any) => {
              const opacity = 0.25 + (props.payload?.weight ?? 0.2) * 0.75;
              const radius = 3 + (props.payload?.weight ?? 0.2) * 4;
              const isCursor = Math.round(props.payload?.time ?? -1) === cursor;
              return (
                <circle
                  cx={props.cx}
                  cy={props.cy}
                  r={isCursor ? radius + 1.5 : radius}
                  fill={isCursor ? "#ffffff" : `rgba(185,244,154,${opacity})`}
                  stroke={isCursor ? "var(--brand-accent)" : "rgba(185,244,154,.18)"}
                  strokeWidth={isCursor ? 1.5 : 1}
                />
              );
            }}
          />
        </ScatterChart>
      </ResponsiveContainer>
      <div className="heatmap-axis">
        <span>window start</span>
        <span>50-sample sliding buffer</span>
        <span>now</span>
      </div>
    </div>
  );
}

export default function Home() {
  const [controls, setControls] = useState<StreamControls>({
    rpm: 5203,
    map: 0.84,
    altitude: 8200,
    cylinderBias: 18,
    ambientC: 15,
  });
  const [enduranceId, setEnduranceId] = useState<string | null>(null);
  const [edgeMode, setEdgeMode] = useState(false);
  const { telemetry, history, enduranceTrend, connection } =
    usePrognosticStream(controls, enduranceId, edgeMode);
  if (!telemetry)
    return (
      <main className="model-loading">
        <h1>AeroTwin</h1>
        <p role="status">
          {connection === "reconnecting"
            ? "Telemetry unavailable. Reconnecting automatically…"
            : "Waiting for the server-trained models and live telemetry…"}
        </p>
        <div className="loading-skeletons" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
        <p>No health or remaining-life estimates are shown without telemetry. {connection === "reconnecting" ? "Check the ground-station connection if this continues." : "The dashboard will open when the first sample arrives."}</p>
      </main>
    );
  return (
    <Dashboard
      controls={controls}
      setControls={setControls}
      telemetry={telemetry}
      history={history}
      enduranceTrend={enduranceTrend}
      enduranceId={enduranceId}
      setEnduranceId={setEnduranceId}
      connection={connection}
      edgeMode={edgeMode}
      setEdgeMode={setEdgeMode}
    />
  );
}

function Dashboard({
  controls,
  setControls,
  telemetry,
  history,
  enduranceTrend,
  enduranceId,
  setEnduranceId,
  connection,
  edgeMode,
  setEdgeMode,
}: {
  controls: StreamControls;
  setControls: React.Dispatch<React.SetStateAction<StreamControls>>;
  telemetry: TelemetrySnapshot;
  history: TelemetryPoint[];
  enduranceTrend: EnduranceTrendPoint[];
  enduranceId: string | null;
  setEnduranceId: (id: string | null) => void;
  connection: "connecting" | "live" | "reconnecting";
  edgeMode: boolean;
  setEdgeMode: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const { user, signOut } = useDemoAuth();
  const role = user.role;
  const isMaintenanceEngineer = role === "Maintenance Engineer";
  const [activeSection, setActiveSection] = useState(navItems[0].target);
  const scrollToSection = (target: string) => {
    setActiveSection(target);
    setSidebarOpen(false);
    document
      .getElementById(target)
      ?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  };
  useEffect(() => {
    const targets = navItems.map(item => item.target);
    const elements = targets
      .map(id => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (!elements.length) return;
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActiveSection(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -70% 0px", threshold: 0 }
    );
    elements.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  const [isLight, setIsLight] = useState(
    () => getThemePreference() === "light"
  );
  const { data: flightLogs = [], error: replayError, mutate: refreshReplays } = useSWR<FlightLog[]>("/api/replay/runs", fetchReplayRuns, { refreshInterval: 10000 });
  const [compareRun, setCompareRun] = useState(1);
  const [replayRun, setReplayRun] = useState(0);
  const [scenarioRunId, setScenarioRunId] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const datasetPrediction = telemetry;
  const outOfRange = telemetry.outOfRangeFeatures.length > 0;
  const isCritical = datasetPrediction.anomaly > 0.66;
  const isDegraded = datasetPrediction.anomaly > 0.46;
  const statusTone =
    connection !== "live"
      ? "slate"
      : outOfRange
        ? "amber"
        : isCritical
          ? "rose"
          : isDegraded
            ? "amber"
            : "mint";
  const statusLabel =
    connection !== "live"
      ? "STALE / RECONNECTING"
      : outOfRange
        ? "OUT OF TRAINING RANGE"
        : isCritical
          ? "CRITICAL / MODEL ESTIMATE"
          : isDegraded
            ? "DEGRADED / REVIEW"
            : "IN-RANGE / MODEL ESTIMATE";
  const updateControl = (key: keyof StreamControls, value: number) =>
    setControls(previous => ({ ...previous, [key]: value }));
  const [transitionRunning, setTransitionRunning] = useState(false);
  const runRapidThrottleTransition = () => {
    if (transitionRunning) return;
    setTransitionRunning(true);
    const startRpm = controls.rpm,
      startMap = controls.map;
    const targetRpm = startRpm < 5200 ? 7000 : 3400;
    const targetMap = startRpm < 5200 ? 1.02 : 0.5;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setControls(previous => ({ ...previous, rpm: targetRpm, map: targetMap }));
      setTransitionRunning(false);
      return;
    }
    const durationMs = 2500;
    const startTime = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startTime) / durationMs);
      const eased =
        progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      setControls(previous => ({
        ...previous,
        rpm: Math.round(startRpm + (targetRpm - startRpm) * eased),
        map: Number((startMap + (targetMap - startMap) * eased).toFixed(2)),
      }));
      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        setTransitionRunning(false);
      }
    };
    requestAnimationFrame(tick);
  };
  const cylinderRows = useMemo(
    () =>
      telemetry.cht.map((cht, index) => ({
        cylinder: `CYL ${index + 1}`,
        cht,
        egt: telemetry.egt[index],
        residual: telemetry.physics.residuals.egt[index],
        state: telemetry.egt[index] > 840 || cht > 225 ? "WATCH" : "NOMINAL",
      })),
    [telemetry.cht, telemetry.egt, telemetry.physics.residuals.egt]
  );
  const selectedReplay = flightLogs[replayRun] ?? flightLogs[0];
  const comparisonReplay = flightLogs[compareRun] ?? flightLogs[1] ?? flightLogs[0];
  const replayPoint = selectedReplay?.data[replayIndex] ?? selectedReplay?.data[0];
  useEffect(() => {
    if (!scenarioRunId) return;
    const index = flightLogs.findIndex(run => run.id === scenarioRunId);
    if (index >= 0) { setReplayRun(index); setReplayIndex(0); setIsPlaying(true); setScenarioRunId(null); }
  }, [flightLogs, scenarioRunId]);

  useEffect(() => {
    saveThemePreference(isLight ? "light" : "dark");
  }, [isLight]);

  useEffect(() => {
    if (selectedReplay?.id) saveLastReplayId(selectedReplay.id);
  }, [selectedReplay?.id]);

  useEffect(() => {
    if (!isPlaying || !selectedReplay?.data.length) return;
    const timer = window.setInterval(() => setReplayIndex(value => {
      if (value >= selectedReplay.data.length - 1) { setIsPlaying(false); return value; }
      return value + 1;
    }), 700 / replaySpeed);
    return () => window.clearInterval(timer);
  }, [isPlaying, selectedReplay?.id, selectedReplay?.data.length, replaySpeed]);

  if (!selectedReplay || !replayPoint) return <main className="model-loading"><h1>Ground control</h1><p role="status">{replayError ? "Stored replay is unavailable. Check the replay service and try again." : "Loading stored mission telemetry. The live stream is still connecting."}</p>{!replayError && <div className="loading-skeletons" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>}<ScenarioPanel role={role} onRun={async (id, nextControls) => { setControls(nextControls); setScenarioRunId(id); await refreshReplays(); }} /></main>;

  return (
    <div className={`app-shell ${isLight ? "light-mode" : ""}`}>
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>AEROTWIN</strong>
            <small>FLIGHT SYSTEMS</small>
          </div>
        </div>
        <div className="asset-chip">
          <div className="pulse-ring">
            <span />
          </div>
          <div>
            <span>PRIMARY ASSET</span>
            <strong>AP-04 / TAPAS-BH-201</strong>
          </div>
          <ChevronRight size={14} />
        </div>
        <nav className="nav-list">
          {navItems.map(({ label, icon: Icon, target }) => {
            const active = activeSection === target;
            return (
              <button
                key={label}
                className={`nav-item ${active ? "active" : ""}`}
                onClick={() => scrollToSection(target)}
              >
                <Icon size={17} />
                <span>{label}</span>
                {active && <i />}
              </button>
            );
          })}
          <Link href="/model-evidence" className={`nav-item ${!isMaintenanceEngineer ? "role-nav-locked" : ""}`}>
            <BrainCircuit size={17} />
            <span>Model evidence</span>
            {!isMaintenanceEngineer && <LockKeyhole size={13} aria-label="Only Engineer can do this" />}
          </Link>
        </nav>
        <div className="sidebar-bottom"><div className="operator"><div className="avatar" aria-hidden="true">{initials(user.displayName)}</div><div><strong>{user.displayName}</strong><span>{role}</span></div></div></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="header-identity">
            <button type="button" className="mobile-menu" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label={sidebarOpen ? "Close navigation" : "Open navigation"} aria-expanded={sidebarOpen}><Menu size={19} /></button>
            <div className="header-brand" aria-label="AeroTwin"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><strong>AeroTwin</strong></div>
            <span className="header-page">Overview</span>
          </div>
          <div className="top-actions">
            <span className={`connection-pill ${connection === "live" ? "online" : "offline"}`} role="status" aria-live="polite">{connection === "live" ? <Check size={14} /> : <RotateCcw size={14} />}{connection === "live" ? "Live" : "Reconnecting"}</span>
            <button type="button" className="icon-button" aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"} onClick={() => setIsLight(value => !value)}>{isLight ? <Moon size={18} /> : <Sun size={18} />}</button>
            <div className="user-chip">
              <div className="top-avatar" aria-hidden="true">{initials(user.displayName)}</div>
              <span className="user-name">{user.displayName}</span>
              <span className="role-badge">{role}</span>
              <button type="button" className="signout-button" onClick={signOut}>Sign out</button>
            </div>
          </div>
        </header>

        <div className="page-wrap">
          <EngineStatusSummary telemetry={telemetry} connection={connection} now={now} />
          <section className={`panel role-workspace ${isMaintenanceEngineer ? "engineer" : "operator-view"}`} aria-label={`${role} workspace`}>
            <div><span className="section-label">{isMaintenanceEngineer ? "MAINTENANCE ENGINEER / DIAGNOSTIC WORKSPACE" : "OPERATOR / FLIGHT DECISION WORKSPACE"}</span><h2>{isMaintenanceEngineer ? "Investigate and clear the asset" : "Monitor and respond in flight"}</h2><p>{isMaintenanceEngineer ? `Model health ${telemetry.health}/100 · RUL ${telemetry.rul.toFixed(1)} h · ${telemetry.faults.length} active fault types. Review residuals, component evidence and maintenance actions below.` : `Live health ${telemetry.health}/100 · ${telemetry.faults.length ? "Review engine alert and consider return-to-base." : "No active faults; continue monitoring."} Use mission safety planner for recovery decisions.`}</p></div>
            <span className="role-workspace-badge">{isMaintenanceEngineer ? "DIAGNOSTICS + MODEL EVIDENCE" : "FLIGHT STATUS + ROUTE SAFETY"}</span>
          </section>
          {connection !== "live" && (
            <p className="evidence-notice" role="alert">
              Telemetry reconnecting. Values below are the last received sample,
              not live predictions.
            </p>
          )}
          {outOfRange && (
            <p className="evidence-notice" role="status">
              <strong>Outside model training range:</strong>{" "}
              {telemetry.outOfRangeFeatures.join(", ")}. Confidence is reduced;
              these estimates are not reliable for flight decisions.{" "}
              {isMaintenanceEngineer && (
                <>
                  {" "}
                  <Link href="/model-evidence">Review model evidence</Link>.
                </>
              )}
            </p>
          )}
          <section className="page-intro">
            <div>
              <div className="eyebrow mint-text">
                <span className="status-dot" />
                AI-ENABLED DIGITAL TWIN / REV 2026.4.1
              </div>
              <h2>
                Engine health <em>at a glance.</em>
              </h2>
              <p>
                See the current engine condition, the recommended next step, and the readings behind it.
              </p>
            </div>
            <div className="intro-actions">
              <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
              <button className="outline-button">
                <LockKeyhole size={14} />{" "}
                {enduranceId ? "ENDURANCE RUN" : "IMMUTABLE RUN"}{" "}
                <span>
                  {enduranceId ? enduranceId.slice(0, 12) : "LIVE SIMULATION"}
                </span>
              </button>
            </div>
          </section>

          <div className="stats-grid">
            <StatTile
              label="ENGINE HEALTH"
              value={`${datasetPrediction.health}`}
              unit="/100"
              icon={ShieldCheck}
              tone="mint"
            />
            <StatTile
              label="EST. REMAINING LIFE"
              value={`${datasetPrediction.rul.toFixed(1)}`}
              unit="h"
              icon={TimerReset}
              tone="violet"
            />
            <StatTile
              label="MODEL CONFIDENCE"
              value={`${datasetPrediction.confidence}`}
              unit="%"
              icon={BrainCircuit}
              tone="cyan"
            />
            <StatTile
              label="HYBRID ANOMALY"
              value={datasetPrediction.anomaly.toFixed(2)}
              unit="/1.00"
              icon={Zap}
              tone="amber"
            />
          </div>

          <section className="hero-grid">
            <article className="panel hero-panel">
              <div className="panel-top">
                <SectionLabel>
                  01 / ENGINE HEALTH MONITORING{" "}
                  <StatusPill tone={statusTone}>
                    {connection === "live" ? "LIVE" : "STALE"}
                  </StatusPill>
                </SectionLabel>
                <span className="panel-code">MODEL / RANDOM FOREST</span>
              </div>
              <div className="hero-body">
                <div className="health-column">
                  <CircularHealth
                    health={datasetPrediction.health}
                    anomaly={datasetPrediction.anomaly}
                  />
                  <div className="health-status">
                    <span className="status-dot" />
                    {outOfRange
                      ? "OUT-OF-RANGE ESTIMATE"
                      : "DEMO MODEL ESTIMATE"}
                  </div>
                  <p>
                    Server-trained Random Forest inference over eight engine
                    sensor features.
                  </p>
                </div>
                <div className="hero-copy">
                  <div className="eyebrow">AP-04 / AERO-PISTON ENGINE</div>
                  <h2>
                    Hybrid residual
                    <br />
                    <span>engine twin.</span>
                  </h2>
                  <p className="muted-copy">
                Two Random Forest regressors plus a training-only degradation trend estimate health and remaining life. The final 20% chronological holdout compares both methods; confidence is a heuristic, not a safety probability. Verify out-of-range readings independently.
                  </p>
                  <div className="hero-tags">
                    <span>
                      <CircleDot size={12} /> PHYSICS BASELINE
                    </span>
                    <span>
                      <Database size={12} /> TAPAS DATASET /{" "}
                      {datasetPrediction.sampleCount.toLocaleString()} ROWS
                    </span>
                    <span>
                      <BrainCircuit size={12} /> TRAINED RF / 64 TREES
                    </span>
                    <span>
                      <Wifi size={12} /> 150 MS STREAM
                    </span>
                  </div>
                  <RoleSection role={role} required="Maintenance Engineer"><div className="mini-chart">
                    <div className="mini-chart-label">
                      <span>ANOMALY TRAJECTORY</span>
                      <strong>
                        {telemetry.anomaly.toFixed(2)}{" "}
                        <ArrowUpRight size={12} />
                      </strong>
                    </div>
                    <ResponsiveContainer width="100%" height={68}>
                      <AreaChart data={history}>
                        <defs>
                          <linearGradient
                            id="anomaly-fill"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="0%"
                              stopColor="var(--brand-accent)"
                              stopOpacity={0.24}
                            />
                            <stop
                              offset="100%"
                              stopColor="var(--brand-accent)"
                              stopOpacity={0}
                            />
                          </linearGradient>
                        </defs>
                        <Area
                          type="monotone"
                          dataKey="residual"
                          stroke="var(--brand-accent)"
                          fill="url(#anomaly-fill)"
                          strokeWidth={2}
                          dot={false}
                        />
                        <YAxis hide domain={[0, 6]} />
                        <XAxis hide dataKey="time" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div></RoleSection>
                </div>
              </div>
            </article>

            <article className="panel controls-panel">
              <div className="panel-top">
                <SectionLabel>
                  <SlidersHorizontal size={14} /> FLIGHT CONTROL INPUTS
                </SectionLabel>
                <span className="live-text">
                  <span className="live-dot" />
                  SIMULATION
                </span>
              </div>
              <div className="controls-intro">
                <h3>Test the twin.</h3>
                <p>
                  Drive sanitized telemetry through the physics layer and watch
                  the prognostic response.
                </p>
              </div>
              <RoleSection role={role} required="Operator"><fieldset
                className="control-list"
                disabled={Boolean(enduranceId) || isMaintenanceEngineer}
              >
                <ControlSlider
                  label="Engine RPM"
                  value={controls.rpm}
                  min={3200}
                  max={7200}
                  step={1}
                  unit="rpm"
                  hint="crank speed"
                  onChange={value => updateControl("rpm", value)}
                />
                <ControlSlider
                  label="MAP / load"
                  value={controls.map}
                  min={0.42}
                  max={1.08}
                  step={0.01}
                  unit="bar"
                  hint="manifold absolute pressure"
                  onChange={value => updateControl("map", value)}
                />
                <ControlSlider
                  label="Flight altitude"
                  value={controls.altitude}
                  min={500}
                  max={16000}
                  step={100}
                  unit="ft"
                  hint="density ratio adjusts baseline"
                  onChange={value => updateControl("altitude", value)}
                />
                <ControlSlider
                  label="Ambient temperature"
                  value={controls.ambientC}
                  min={-10}
                  max={50}
                  step={1}
                  unit="°C"
                  hint="hot-weather stress test"
                  onChange={value => updateControl("ambientC", value)}
                />
                <ControlSlider
                  label="Cylinder bias"
                  value={controls.cylinderBias}
                  min={0}
                  max={80}
                  step={1}
                  unit="%"
                  hint="inject isolated fault"
                  onChange={value => updateControl("cylinderBias", value)}
                />
              </fieldset></RoleSection>
              <EndurancePanel
                controls={controls}
                telemetry={telemetry}
                trend={enduranceTrend}
                activeId={enduranceId}
                onRunChange={setEnduranceId}
                role={role}
              />
              <RoleControl role={role} required="Operator"><button
                type="button"
                className="run-button"
                disabled={transitionRunning || Boolean(enduranceId) || isMaintenanceEngineer}
                aria-disabled={isMaintenanceEngineer || undefined}
                onClick={runRapidThrottleTransition}
              >
                {transitionRunning
                  ? "RUNNING TRANSIENT…"
                  : "RUN RAPID THROTTLE TRANSITION"}
              </button></RoleControl>
              <div className="control-footnote">
                <span>
                  <Check size={13} /> input sanitizer armed
                </span>
                <span>5 / 5 channels mapped</span>
              </div>
            </article>
          </section>

          <RoleSection role={role} required="Maintenance Engineer"><EngineTwin3D telemetry={telemetry} controls={controls} connection={connection} role={role} /></RoleSection>

          <section id="section-telemetry" className="section-block">
            <div className="section-heading">
              <div>
                <SectionLabel>
                  02 / LIVE TELEMETRY{" "}
                  <StatusPill tone="mint">150 MS INTERVAL</StatusPill>
                </SectionLabel>
                <h2>
                  See the machine <em>thinking.</em>
                </h2>
              </div>
              <div className="heading-meta">
                <span>
                  CAN-FD <strong>{telemetry.can?.frameRate ?? 250} FPS</strong>
                </span>
                <span className="divider" />
                <span>
                  ALT DENSITY RATIO{" "}
                  <strong>{(1 - controls.altitude / 45000).toFixed(3)}</strong>
                </span>
              </div>
            </div>
            <div className="telemetry-grid">
              <div className="telemetry-card">
                <div className="telemetry-icon">
                  <Gauge size={17} />
                </div>
                <span>ENGINE SPEED / MAP <InfoTooltip text="What this means: MAP is manifold absolute pressure, an indicator of engine load; shown in bar." /></span>
                <strong>
                  {controls.rpm.toLocaleString()}
                  <small>rpm · {controls.map.toFixed(2)} bar</small>
                </strong>
                <StatusPill>Current reading</StatusPill>
              </div>
              <div className="telemetry-card">
                <div className="telemetry-icon amber">
                  <Thermometer size={17} />
                </div>
                <MetricLabel label="OIL TEMPERATURE / PRESSURE" meaning="Oil heat in °C and supply pressure in psi; low pressure or high heat needs attention." />
                <strong>
                  {telemetry.oilTemp.toFixed(1)}
                  <small>°C · {telemetry.oilPressure.toFixed(1)} psi</small>
                </strong>
                <StatusPill tone={telemetry.oilPressure < 24 ? "rose" : "mint"}>
                  {telemetry.oilPressure < 24 ? "LOW" : "STABLE"}
                </StatusPill>
              </div>
              <div className="telemetry-card">
                <div className="telemetry-icon cyan">
                  <Zap size={17} />
                </div>
                <MetricLabel label="FUEL FLOW" meaning="Fuel delivered to the engine per hour, in litres per hour." />
                <strong>
                  {telemetry.fuelFlow}
                  <small>L/h</small>
                </strong>
                <StatusPill>INJECTOR FEED</StatusPill>
              </div>
              <div className="telemetry-card">
                <div className="telemetry-icon rose">
                  <Activity size={17} />
                </div>
                <MetricLabel label="VIBRATION" meaning="Engine vibration in millimetres per second; a higher value can indicate imbalance or combustion trouble." />
                <strong>
                  {telemetry.vibration}
                  <small>mm/s</small>
                </strong>
                <StatusPill tone={telemetry.vibration > 4 ? "rose" : "mint"}>
                  {telemetry.vibration > 4 ? "HIGH" : "NOMINAL"}
                </StatusPill>
              </div>
              <div className="telemetry-card">
                <div className="telemetry-icon cyan">
                  <BatteryCharging size={17} />
                </div>
                <MetricLabel label="BATTERY / ALTERNATOR" meaning="Battery voltage and estimated alternator output health." />
                <strong>
                  {telemetry.batteryVoltage}
                  <small>V · {telemetry.alternatorHealth}%</small>
                </strong>
                <StatusPill>CAN-FD</StatusPill>
              </div>
              <div className="telemetry-card">
                <div className="telemetry-icon">
                  <Gauge size={17} />
                </div>
                <MetricLabel label="INJECTION TIMING" meaning="Fuel injection timing in crankshaft degrees before top dead centre (BTDC)." />
                <strong>
                  {telemetry.injectionTiming}
                  <small>° BTDC</small>
                </strong>
                <StatusPill>ECU SYNCH</StatusPill>
              </div>
              <RoleSection role={role} required="Maintenance Engineer"><div className="telemetry-card fault-card">
                <div className="telemetry-icon amber">
                  <ShieldAlert size={17} />
                </div>
                <MetricLabel label="ACTIVE FAULTS" meaning="Number of classified fault types in the latest live sample; review each before acting." />
                <strong>
                  {telemetry.faults?.length ?? 0}
                  <small> active</small>
                </strong>
                <div className="fault-chip-row">
                  {(telemetry.faults?.length
                    ? telemetry.faults
                    : [{ type: "no classified fault" }]
                  ).map((fault: any) => (
                    <span key={fault.type}>{fault.type}</span>
                  ))}
                </div>
              </div></RoleSection>
              <div className="telemetry-card">
                <div className="telemetry-icon cyan">
                  <Radio size={17} />
                </div>
                <MetricLabel label="ECU DATA LINK" meaning="Frames decoded from the controller area network (CAN) and the current engine control unit (ECU) link state." />
                <strong>
                  {telemetry.can?.frames ?? 18}
                  <small> frames decoded</small>
                </strong>
                <StatusPill>ONLINE</StatusPill>
                <StatusPill
                  tone={
                    telemetry.ecu?.linkState === "OK"
                      ? "mint"
                      : telemetry.ecu?.linkState === "DEGRADED"
                        ? "amber"
                        : "rose"
                  }
                >
                  ECU LINK {telemetry.ecu?.linkState ?? "OK"}
                </StatusPill>
                <RoleControl role={role} required="Operator"><button
                  type="button"
                  className="edge-mode-toggle"
                  aria-pressed={edgeMode}
                  aria-disabled={isMaintenanceEngineer || undefined}
                  disabled={isMaintenanceEngineer}
                  onClick={() => setEdgeMode(value => !value)}
                  title="View signed telemetry sent by the separate onboard process; Random Forest and temporal analysis run on the ground. Onboard controls are fixed in this demo."
                >
                  <StatusPill tone={telemetry.edgeMode ? "amber" : "mint"}>
                    EDGE MODE {telemetry.edgeMode ? "ON" : "OFF"}
                  </StatusPill>
                </button></RoleControl>
                {isMaintenanceEngineer && (
                  <div className="can-debug">
                    <b>RAW CAN FRAMES</b>
                    <div className="can-debug-frames">
                      {telemetry.can?.lastFrames?.map(frame => (
                        <div key={frame.id}>
                          <span>
                            {frame.name} · {frame.id} · DLC {frame.dlc}
                          </span>
                          <code>{frame.data}</code>
                        </div>
                      ))}
                    </div>
                    <small>
                      CRC errors: {telemetry.can?.crcErrors ?? 0} · Counter
                      errors: {telemetry.can?.counterErrors ?? 0}
                    </small>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section
            id="section-diagnostics"
            className={`analysis-grid ${isMaintenanceEngineer ? "" : "operator-analysis"}`}
          >
            <RoleSection role={role} required="Maintenance Engineer"><article className="panel large-panel">
              <div className="panel-top">
                <SectionLabel>
                  03 / PHYSICS RESIDUAL MODEL{" "}
                  <span className="model-badge">
                    ACTUAL − ISA / IDEAL-GAS BASELINE
                  </span>
                </SectionLabel>
                <span className="panel-code">
                  DENSITY RATIO σ /{" "}
                  {(telemetry.physics.densityRatio * 100).toFixed(1)}%
                </span>
              </div>
              <div className="chart-title">
                <div>
                  <h3>
                    EGT residual trajectory{" "}
                    <InfoTooltip text="The orange trace is measured CYL 3 EGT, the dashed trace is the expected healthy EGT from the ISA-atmosphere + ideal-gas thermal baseline, and the green trace is the residual (measured − expected). Random Forest inputs are RPM, MAP, oil temperature and pressure, and four cylinder temperatures." />
                  </h3>
                  <p>
                    Hover the traces to compare the live sensor, physics
                    baseline, and residual delta.
                  </p>
                </div>
                <div className="chart-legend">
                  <span>
                    <i className="line actual" /> actual{" "}
                    <InfoTooltip text="Raw EGT telemetry from the engine sensor." />
                  </span>
                  <span>
                    <i className="line baseline" /> physics baseline{" "}
                    <InfoTooltip text="First-principles ISA-atmosphere + ideal-gas thermal baseline: expected healthy EGT for the current RPM, MAP and altitude, anchored to a calibrated reference cruise point and scaled by intake charge density and ISA cooling-air density." />
                  </span>
                  <span>
                    <i className="line residual" /> residual{" "}
                    <InfoTooltip text="Measured minus physics baseline. Not a Random Forest input; physics residuals feed the hybrid anomaly score and the temporal fault detectors." />
                  </span>
                </div>
              </div>
              <div className="main-chart">
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart
                    data={history}
                    margin={{ top: 12, right: 12, bottom: 4, left: -18 }}
                  >
                    <CartesianGrid
                      vertical={false}
                      stroke="#24353a"
                      strokeDasharray="2 6"
                    />
                    <XAxis
                      dataKey="time"
                      tick={{ fill: "var(--text-secondary)", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="temp"
                      domain={[
                        (min: number) => Math.floor(min - 5),
                        (max: number) => Math.ceil(max + 5),
                      ]}
                      tick={{ fill: "var(--text-secondary)", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="residual"
                      orientation="right"
                      domain={[
                        (min: number) => Math.floor(Math.min(min, -8)),
                        (max: number) => Math.ceil(Math.max(max, 8)),
                      ]}
                      hide
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#172126",
                        border: "1px solid #2b4145",
                        borderRadius: 8,
                        color: "#f4f7f2",
                        fontSize: 12,
                      }}
                      formatter={(value: number, name: string) => [
                        name === "residual"
                          ? `${value >= 0 ? "+" : ""}${value.toFixed(1)} °C Δ`
                          : `${value.toFixed(1)} °C`,
                        name === "actual"
                          ? "Measured telemetry"
                          : name === "baseline"
                            ? "Physics baseline"
                            : "Physics residual",
                      ]}
                    />
                    <Line
                      yAxisId="temp"
                      type="monotone"
                      dataKey="actual"
                      stroke="var(--status-watch)"
                      strokeWidth={2.3}
                      dot={false}
                    />
                    <Line
                      yAxisId="temp"
                      type="monotone"
                      dataKey="baseline"
                      stroke="#8ba8a5"
                      strokeWidth={1.5}
                      strokeDasharray="5 5"
                      dot={false}
                    />
                    <Line
                      yAxisId="residual"
                      type="monotone"
                      dataKey="residual"
                      stroke="var(--brand-accent)"
                      strokeWidth={1.7}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="chart-foot">
                <span>
                  <CircleDot size={13} /> CYL 3 · physics residuals feed the
                  hybrid anomaly score
                </span>
                <span>window 50 samples / 1.8s shown</span>
              </div>
            </article></RoleSection>

            <RoleSection role={role} required="Maintenance Engineer"><EfficiencyTrend run={selectedReplay} /></RoleSection>
          </section>

          <ScenarioPanel role={role} activeRun={scenarioRunId ? undefined : flightLogs.find(run => run.id.startsWith("SCN-"))} onRun={async (id, nextControls) => { setControls(nextControls); setScenarioRunId(id); setIsPlaying(false); await refreshReplays(); }} />
          <section id="section-mission-replay" className="replay-section">
            <div className="replay-heading">
              <div>
                <SectionLabel>
                  <History size={14} /> 04 / MISSION REPLAY
                </SectionLabel>
                <h2>
                  Reproduce the <em>event.</em>
                </h2>
                <p>
                  Replay stored simulated telemetry from SQLite. Compare sensor,
                  physics baseline, and residual traces on a shared cursor.
                </p>
              </div>
              <div className="replay-picker">
                <label htmlFor="replay-run">HISTORICAL RUN</label>
                <select
                  id="replay-run"
                  value={replayRun}
                  onChange={event => {
                    setReplayRun(Number(event.target.value));
                    setReplayIndex(0);
                    setIsPlaying(false);
                  }}
                >
                  {flightLogs.map((run, index) => (
                    <option key={run.id} value={index}>
                      {run.id} · {run.mission}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="panel replay-panel">
              <div className="replay-meta">
                <div>
                  <span>MISSION</span>
                  <strong>{selectedReplay.mission}</strong>
                </div>
                <div>
                  <span>DATE</span>
                  <strong>{selectedReplay.date}</strong>
                </div>
                <div>
                  <span>AIRFRAME</span>
                  <strong>{selectedReplay.aircraft}</strong>
                </div>
                <div>
                  <span>RUN · {selectedReplay.sampleCount} STORED SAMPLES</span>
                  <strong>{selectedReplay.id}</strong>
                </div>
                <StatusPill tone="slate">IMMUTABLE</StatusPill>
              </div>
              <div className="replay-chart">
                <ResponsiveContainer width="100%" height={205}>
                  <ComposedChart
                    data={selectedReplay.data}
                    margin={{ top: 12, right: 12, bottom: 4, left: -18 }}
                  >
                    <CartesianGrid
                      vertical={false}
                      stroke="#24353a"
                      strokeDasharray="2 6"
                    />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "var(--text-secondary)", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="temp"
                      domain={["auto", "auto"]}
                      tick={{ fill: "var(--text-secondary)", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="residual"
                      domain={["auto", "auto"]}
                      orientation="right"
                      hide
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#172126",
                        border: "1px solid #2b4145",
                        borderRadius: 8,
                        color: "#f4f7f2",
                        fontSize: 12,
                      }}
                      formatter={(value: number, name: string) => [
                        name === "residual"
                          ? `${value.toFixed(1)} Δ`
                          : `${value.toFixed(1)} °C`,
                        name === "actual"
                          ? "Measured telemetry"
                          : name === "baseline"
                            ? "Otto baseline"
                            : "AI residual",
                      ]}
                    />
                    <Line
                      yAxisId="temp"
                      type="monotone"
                      dataKey="actual"
                      stroke="var(--status-watch)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      yAxisId="temp"
                      type="monotone"
                      dataKey="baseline"
                      stroke="#8ba8a5"
                      strokeWidth={1.5}
                      strokeDasharray="5 5"
                      dot={false}
                    />
                    <Line
                      yAxisId="residual"
                      type="monotone"
                      dataKey="residual"
                      stroke="var(--brand-accent)"
                      strokeWidth={1.7}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="replay-controls">
                <button
                  className="icon-button"
                  onClick={() => setReplayIndex(0)}
                  aria-label="Restart replay"
                >
                  <SkipBack size={16} />
                </button>
                <button
                  className="play-button"
                  onClick={() => setIsPlaying(value => !value)}
                  aria-label={isPlaying ? "Pause replay" : "Play replay"}
                >
                  {isPlaying ? (
                    <Pause size={15} fill="currentColor" />
                  ) : (
                    <Play size={15} fill="currentColor" />
                  )}
                </button>
                <button
                  className="icon-button"
                  onClick={() =>
                    setReplayIndex(value =>
                      Math.min(selectedReplay.data.length - 1, value + 1)
                    )
                  }
                  aria-label="Advance replay"
                >
                  <SkipForward size={16} />
                </button>
                <label className="replay-speed">SPEED <select aria-label="Replay speed" value={replaySpeed} onChange={event => setReplaySpeed(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></label>
                <input
                  aria-label="Replay timeline"
                  type="range"
                  min={0}
                  max={selectedReplay.data.length - 1}
                  value={replayIndex}
                  onChange={event => {
                    setReplayIndex(Number(event.target.value));
                    setIsPlaying(false);
                  }}
                />
                <strong>
                  {replayPoint.label}{" "}
                  <span>/ {selectedReplay.duration}</span>
                </strong>
                <span className="replay-cursor">
                  CURSOR · <b>{replayPoint.actual.toFixed(1)}°C</b> /{" "}
                  <b>{replayPoint.residual.toFixed(1)} Δ</b>
                </span>
              </div>
            </div>
          </section>

          <section className="comparison-section">
            <div className="comparison-heading">
              <div>
                <SectionLabel>
                  <Columns2 size={14} /> 05 / MISSION COMPARISON
                </SectionLabel>
                <h2>
                  Compare two <em>histories.</em>
                </h2>
                <p>
                  Run the same cursor across two immutable flight logs to
                  isolate degradation and model residual drift.
                </p>
              </div>
              <div className="comparison-sync">
                <span className="live-dot" /> SHARED CURSOR{" "}
                <b>{replayPoint.label}</b>
              </div>
            </div>
            <div className="comparison-grid">
              <ReplayComparisonCard
                run={selectedReplay}
                runs={flightLogs}
                cursor={replayIndex}
                onSelect={value => {
                  setReplayRun(value);
                  setReplayIndex(0);
                  setIsPlaying(false);
                }}
                accent="mint"
              />
              <ReplayComparisonCard
                run={comparisonReplay}
                runs={flightLogs}
                cursor={replayIndex}
                onSelect={value => {
                  setCompareRun(value);
                  setReplayIndex(0);
                  setIsPlaying(false);
                }}
                accent="violet"
              />
            </div>
            <div className="comparison-footer">
              <span>
                <Columns2 size={13} /> synchronized comparison view
              </span>
                <span>both traces are stored telemetry, aligned by sample index</span>
            </div>
          </section>

          <RoleSection role={role} required="Maintenance Engineer"><MaintenanceAdvisory advisories={telemetry.advisories} /></RoleSection>
          <MissionPlanner telemetry={telemetry} missionId={selectedReplay.id} role={role} />

          <RoleSection role={role} required="Maintenance Engineer"><ModelEvidence /></RoleSection>

          <section className="lower-grid">
            <RoleSection role={role} required="Maintenance Engineer"><article className="panel cylinder-panel">
              <div className="panel-top">
                <SectionLabel>07 / ISOLATED MULTI-CYLINDER PHM</SectionLabel>
                <span className="panel-code">MAP / OIL / CHT / EGT</span>
              </div>
              <div className="cylinder-table">
                <div className="table-row table-head">
                  <span>CHANNEL</span>
                  <span>CHT <InfoTooltip text="What this means: cylinder head temperature, in °C. Higher readings can signal heat stress." /></span>
                  <span>EGT <InfoTooltip text="What this means: exhaust gas temperature, in °C. Compare cylinders to spot combustion differences." /></span>
                  <span>RESIDUAL <InfoTooltip text="What this means: the difference between the measured temperature and the expected physics baseline." /></span>
                  <span>STATE</span>
                </div>
                {cylinderRows.map(row => (
                  <div className="table-row" key={row.cylinder}>
                    <span className="channel">
                      <span className="cylinder-dot" />
                      {row.cylinder}
                    </span>
                    <strong>
                      {row.cht.toFixed(1)}
                      <small>°C</small>
                    </strong>
                    <strong>
                      {row.egt.toFixed(1)}
                      <small>°C</small>
                    </strong>
                    <strong className={row.residual > 1.8 ? "amber-text" : ""}>
                      {row.residual.toFixed(1)}
                      <small>Δ</small>
                    </strong>
                    <StatusPill tone={row.state === "WATCH" ? "amber" : "mint"}>
                      {row.state}
                    </StatusPill>
                  </div>
                ))}
              </div>
              <div className="cylinder-footer">
                <span>
                  <Check size={13} /> sensor map complete
                </span>
                <span>{Number.isFinite(new Date(telemetry.ts).getTime()) ? `Last sample ${Math.max(0, Math.floor((now - new Date(telemetry.ts).getTime()) / 1000))} s ago` : "Sample time unavailable"}</span>
              </div>
            </article></RoleSection>
            <RoleSection role={role} required="Maintenance Engineer"><article className="panel anomaly-panel">
              <div className="panel-top">
                <SectionLabel>08 / DIAGNOSTIC WORKSPACE</SectionLabel>
                <button className="text-button">
                  VIEW QUEUE <ArrowUpRight size={13} />
                </button>
              </div>
              <div className="anomaly-list">
                {telemetry.faults.length === 0 && <p className="empty-replay">No active faults in the current live telemetry. Review persisted faults in the mission PDF.</p>}
                {telemetry.faults.map((fault, index) => <div className="anomaly-row" key={`${fault.type}-${index}`}><div className="anomaly-icon amber"><AlertTriangle size={14} /></div><div className="anomaly-copy"><strong>{fault.type}</strong><p>{fault.detail} · confidence {(fault.confidence * 100).toFixed(0)}%</p></div><StatusPill tone={fault.severity === "HIGH" ? "rose" : "amber"}>{fault.severity}</StatusPill></div>)}
              </div>
            </article></RoleSection>
          </section>

          <footer className="page-footer">
            <span>
              <span className="live-dot" /> AEROTWIN MISSION SYSTEMS
            </span>
            <span>
              MODEL VERSION <b>{telemetry.model}</b>
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}
