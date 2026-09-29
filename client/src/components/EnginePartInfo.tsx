import { AlertTriangle, CheckCircle2, CircleHelp, Radio } from "lucide-react";
import type { Connection, EnginePart, PartState } from "@/lib/engineTelemetry";

export function PartStatus({ state, stale = false }: { state: PartState; stale?: boolean }) {
  const Icon = stale ? Radio : state === "NOMINAL" ? CheckCircle2 : state === "WATCH" || state === "CRITICAL" ? AlertTriangle : CircleHelp;
  return <span className="twin-part-status" data-state={stale ? "STALE" : state}><Icon size={13} aria-hidden="true" />{stale ? `STALE · ${state}` : state}</span>;
}

export function EnginePartInfo({ part, connection }: { part: EnginePart; connection: Connection }) {
  return <article className="twin-part-info" aria-label={`${part.label} explanation`}>
    <div><h4>{part.label}</h4><PartStatus state={part.state} stale={connection !== "live"} /></div>
    <p>{part.purpose}</p><p className="twin-material">Material · {part.material}</p>
    {part.state === "NO SENSOR" ? <p>No live sensor for this part</p> : <><p><strong>{part.metric}: {part.value}</strong></p><p>Safe range: {part.safe}</p></>}
    <p><strong>{connection !== "live" ? "Why is this grey? " : part.state === "CRITICAL" ? "Why is this red? " : "What sets this colour? "}</strong>{connection !== "live" ? "The connection is not live. Health glow and pulsing are disabled; readings below are from the last sample. " : ""}{part.why}</p>
  </article>;
}
