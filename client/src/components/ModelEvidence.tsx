import useSWR from "swr";
import { Link } from "wouter";
import { Activity, ArrowUpRight, RefreshCw } from "lucide-react";
import type { ModelMetrics } from "@shared/model";
import "./model-evidence.css";

async function fetchMetrics(url: string): Promise<ModelMetrics> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model metrics unavailable (${response.status})`);
  return response.json();
}

export default function ModelEvidence({ standalone = false }: { standalone?: boolean }) {
  const { data, error, isLoading, isValidating, mutate } = useSWR<ModelMetrics>("/api/model/metrics", fetchMetrics, { revalidateOnFocus: true });
  return <section id="model-evidence" className="validation-section model-evidence" aria-labelledby="model-evidence-title">
    <div className="validation-header">
      <div><div className="section-label">09 / MODEL EVIDENCE</div><h2 id="model-evidence-title">Measure the <em>prediction.</em></h2>
        <p>Two trained Random Forest regressors plus a training-only late-life trend. Same chronological holdout for the baseline and revised predictions.</p></div>
      <div className="evidence-actions">
        <span className="evidence-notice">For the source ZIP, use v0&apos;s Block menu → Download ZIP.</span>
        {!standalone && <Link href="/model-evidence" className="outline-button">FULL EVIDENCE <ArrowUpRight size={14} /></Link>}
        <button className="run-button" onClick={() => void mutate()} disabled={isValidating}><RefreshCw size={14} /> {isValidating ? "LOADING" : "REFRESH METRICS"}</button>
      </div>
    </div>
    {isLoading && <p role="status">Loading server-trained model metrics…</p>}
    {error && <p role="alert" className="evidence-notice">{error.message}. {data ? "Showing the last fetched evaluation; it may be stale." : "No placeholder scores are shown. Retry when the API is ready."}</p>}
    {data && <>
      <div className="evidence-meta"><span>{data.version}</span><span>{data.dataset.trainRows} TRAIN / {data.dataset.testRows} TEST</span><span>TIME SPLIT · TRAIN {data.split.trainTimestampSec[0]}–{data.split.trainTimestampSec[1]} s / TEST {data.split.testTimestampSec[0]}–{data.split.testTimestampSec[1]} s</span><span>FOREST SEED {data.split.seed}</span><span>{data.parameters.nEstimators} TREES / TARGET</span></div>
      <div className="metric-grid">
        {[
          { label: "HEALTH / MAE", value: data.targets.health.mae.toFixed(5), unit: "health index · 0–1", tone: "mint" },
          { label: "HEALTH / RMSE", value: data.targets.health.rmse.toFixed(5), unit: "health index · 0–1", tone: "cyan" },
          { label: "RUL / MAE", value: data.targets.rul.mae.toFixed(4), unit: "hours", tone: "violet" },
          { label: "RUL / RMSE", value: data.targets.rul.rmse.toFixed(4), unit: "hours", tone: "amber" },
        ].map(metric => <div className={`metric-card ${metric.tone}`} key={metric.label}><div className="metric-top"><span>{metric.label}</span><Activity size={16} /></div><strong>{metric.value}</strong><span>{metric.unit}</span></div>)}
      </div>
      <div className="panel evidence-panel" style={{ padding: 16, marginBottom: 12 }}><h3>Chronological holdout: before / after</h3><p>{data.degradationMethod}</p><div className="evidence-table-wrap" role="region" aria-label="Baseline and revised holdout metrics" tabIndex={0}><table><thead><tr><th scope="col">Target / model</th><th scope="col">MAE</th><th scope="col">RMSE</th><th scope="col">R²</th></tr></thead><tbody>{(["health", "rul"] as const).flatMap(target => (["baselineTargets", "targets"] as const).map(stage => <tr key={`${target}-${stage}`}><th scope="row">{target} / {stage === "targets" ? "edge trend" : "forest baseline"}</th><td>{data[stage][target].mae.toFixed(4)}</td><td>{data[stage][target].rmse.toFixed(4)}</td><td>{data[stage][target].r2?.toFixed(4) ?? "undefined"}</td></tr>))}</tbody></table></div></div>
      <div className="panel evidence-panel">
        <div className="panel-top"><h3>Feature importance</h3><span className="panel-code">HELD-OUT PERMUTATION / 3 REPEATS</span></div>
        <p>{data.importanceMethod}</p>
        <div className="evidence-table-wrap" tabIndex={0} role="region" aria-label="Feature importance and training ranges">
          <table><caption className="sr-only">Feature importance measured by increase in test MAE; larger positive values indicate more influence.</caption><thead><tr><th scope="col">Feature</th><th scope="col">Health Δ MAE</th><th scope="col">RUL Δ MAE (h)</th><th scope="col">Training range</th></tr></thead>
            <tbody>{[...data.featureImportance].sort((a, b) => b.health - a.health).map(item => {
              const range = data.features.find(feature => feature.name === item.feature);
              return <tr key={item.feature}><th scope="row">{item.feature}</th><td>{item.health.toFixed(5)}</td><td>{item.rul.toFixed(4)}</td><td>{range?.min} – {range?.max}</td></tr>;
            })}</tbody>
          </table>
        </div>
      </div>
      <div className="evidence-notice"><strong>Demo evaluation, not flight certification.</strong><ul>{data.limitations.map(note => <li key={note}>{note}</li>)}</ul></div>
      <details className="panel evidence-details"><summary>Training provenance & confidence method</summary><dl>
        <dt>Dataset</dt><dd>{data.dataset.file} · {data.dataset.rows.toLocaleString()} rows</dd>
        <dt>SHA-256</dt><dd className="evidence-hash">{data.dataset.sha256}</dd>
        <dt>Evaluation</dt><dd>{data.split.method} (rows ordered by timestamp_sec, no shuffling); no refitting or tuning on the test set.</dd>
        <dt>Training completed</dt><dd>{new Date(data.trainedAt).toLocaleString()} · {data.trainingMs.toLocaleString()} ms including evaluation</dd>
        <dt>Configuration</dt><dd>Max depth {data.parameters.maxDepth} · {data.parameters.maxFeatures} features per tree · minimum {data.parameters.minNumSamples} samples</dd>
        <dt>Confidence</dt><dd>{data.confidenceMethod}</dd>
        <dt>R² / health, RUL</dt><dd>{data.targets.health.r2?.toFixed(6) ?? "undefined"}, {data.targets.rul.r2?.toFixed(6) ?? "undefined"}</dd>
      </dl><a href="/api/model/metrics" target="_blank" rel="noreferrer">Open raw metrics JSON</a></details>
    </>}
  </section>;
}
