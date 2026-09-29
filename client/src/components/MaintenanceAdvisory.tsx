import type { MaintenanceAdvisory as Advisory } from "@shared/telemetry";

export function MaintenanceAdvisory({ advisories }: { advisories: Advisory[] }) {
  return <section className="panel maintenance-advisory" aria-labelledby="maintenance-advisory-title">
    <div className="panel-top"><span className="section-label">MAINTENANCE ADVISORY</span><span className="panel-code">LIVE MODEL + ACTIVE FAULTS</span></div>
    <h2 id="maintenance-advisory-title">Maintenance advisory</h2>
    <p>Indicative hours to action, not a certified service interval. Verify readings before dispatch or maintenance decisions.</p>
    <div className="advisory-list">{advisories.map((advisory, index) => <article className="advisory-item" key={`${advisory.component}-${index}`}>
      <div><strong>{advisory.component}</strong><span className={`status-pill ${advisory.urgency === "IMMEDIATE" ? "rose" : advisory.urgency === "SCHEDULE" ? "amber" : "mint"}`}>{advisory.urgency}</span></div>
      <p>{advisory.action}</p><small>{advisory.evidence}</small><b>{advisory.hoursToAction === 0 ? "Act now / before next flight" : `Within ${advisory.hoursToAction.toFixed(1)} h`}</b>
    </article>)}</div>
  </section>;
}
