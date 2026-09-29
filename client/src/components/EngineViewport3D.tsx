import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as T from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { AlertTriangle, CheckCircle2, CircleHelp, Hand, MousePointer2, RotateCcw, Smartphone, Tag, X } from "lucide-react";
import type { StreamControls, TelemetrySnapshot } from "@/hooks/usePrognosticStream";
import { roleGate, type DemoRole } from "@/lib/demoAuth";
import { RoleControl } from "./RoleAccess";
import { buildAeroEngineModel, createAeroMats } from "@/lib/engineModel";
import { MAJOR_PARTS, type EnginePartId } from "@/lib/engineParts";
import { createComponentRegistry } from "@/lib/engineRegistry";
import { deriveEngineParts, engineReadings, formatReading, type Connection } from "@/lib/engineTelemetry";
import { EnginePartInfo, PartStatus } from "./EnginePartInfo";

export type EngineViewportProps = {
  telemetry: TelemetrySnapshot | null; controls: StreamControls; connection: Connection;
  selectedPartId: EnginePartId | null; onSelectPart: (id: EnginePartId) => void;
  exploded: boolean; role: DemoRole;
};

export default function EngineViewport3D(props: EngineViewportProps) {
  const { telemetry, controls, connection, selectedPartId, onSelectPart, role } = props;
  const host = useRef<HTMLDivElement>(null);
  const labelLayer = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ reset: () => void; update: () => void } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [labels, setLabels] = useState(true);
  const [motion, setMotion] = useState(false);
  const [motionStatus, setMotionStatus] = useState("");
  const [tab, setTab] = useState<"health" | "parts" | "alerts">("health");
  const [now, setNow] = useState(Date.now);
  const [intro, setIntro] = useState(() => { try { return sessionStorage.getItem("aerotwin.engine-intro") !== "dismissed"; } catch { return true; } });
  const parts = useMemo(() => deriveEngineParts(telemetry, controls), [telemetry, controls]);
  const readings = useMemo(() => engineReadings(telemetry, controls), [telemetry, controls]);
  const selected = parts.find(part => part.id === selectedPartId);
  const current = useRef({ ...props, labels, motion, parts });
  useLayoutEffect(() => {
    current.current = { ...props, labels, motion, parts };
    runtime.current?.update();
  }, [props, labels, motion, parts]);
  useEffect(() => {
    if (connection === "live") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [connection, telemetry?.ts]);

  useEffect(() => {
    const element = host.current!, layer = labelLayer.current!;
    let renderer: T.WebGLRenderer;
    try { renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" }); }
    catch { setUnavailable(true); return; }
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute("aria-label", "Interactive engine model. Arrow keys rotate; plus and minus zoom. Use the Parts tab to select with the keyboard.");
    renderer.domElement.tabIndex = 0;
    element.appendChild(renderer.domElement);
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(42, 1, .01, 30);
    camera.position.set(1.45, .85, 1.65);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 0, 0);
    orbit.enableDamping = true; orbit.dampingFactor = .08;
    orbit.minDistance = .65; orbit.maxDistance = 6; orbit.zoomSpeed = .9;
    orbit.update(); orbit.saveState();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    orbit.enableDamping = !reduced.matches;
    const hemi = new T.HemisphereLight(0xdce7f5, 0x26333c, 2.1);
    const key = new T.DirectionalLight(0xffffff, 3.4); key.position.set(2.5, 3.5, 2.5);
    const rim = new T.DirectionalLight(0x91cbdc, 1.8); rim.position.set(-2.5, 1, -2);
    scene.add(hemi, key, rim);
    // Modern PBR metals need reflected light; direct-light multipliers alone leave the graphite black.
    const pmrem = new T.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, .04);
    scene.environment = environment.texture; scene.environmentIntensity = .65;
    room.dispose(); pmrem.dispose();
    const materials = createAeroMats();
    const model = buildAeroEngineModel(materials);
    scene.add(model.root);
    const registry = createComponentRegistry(model.root);
    const colors = { NOMINAL: new T.Color(), WATCH: new T.Color(), CRITICAL: new T.Color(), neutral: new T.Color(), selected: new T.Color() };
    const readColors = () => {
      const css = getComputedStyle(element);
      colors.NOMINAL.set(css.getPropertyValue("--status-ok").trim() || "#a9df9e");
      colors.WATCH.set(css.getPropertyValue("--status-watch").trim() || "#f5bb78");
      colors.CRITICAL.set(css.getPropertyValue("--status-critical").trim() || "#ff9b91");
      colors.neutral.set(css.getPropertyValue("--text-secondary").trim() || "#83969a");
      colors.selected.set(css.getPropertyValue("--status-info").trim() || "#9bd5e1");
    };
    readColors();
    const themeObserver = new MutationObserver(readColors);
    const shell = element.closest(".app-shell");
    if (shell) themeObserver.observe(shell, { attributes: true, attributeFilter: ["class"] });
    const labelsDom = MAJOR_PARTS.map((part, i) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "twin-label"; button.textContent = part.name;
      button.addEventListener("click", () => { if (current.current.role === "Maintenance Engineer") current.current.onSelectPart(part.id); });
      layer.appendChild(button);
      return { button, part: registry.parts[i], x: 0, y: 0, width: 0, height: 0, visible: false };
    });
    const sync = () => {
      const value = current.current;
      for (let i = 0; i < registry.parts.length; i++) {
        const part = registry.parts[i], state = value.parts[i].state;
        part.state = state; part.selected = part.id === value.selectedPartId;
        const label = labelsDom[i].button;
        label.title = value.role === "Maintenance Engineer" ? `${value.parts[i].label}: ${value.connection === "live" ? state : "STALE"}` : "Only Engineer can do this";
        label.setAttribute("aria-disabled", String(value.role !== "Maintenance Engineer"));
        label.setAttribute("aria-label", label.title);
        label.dataset.state = value.connection === "live" ? state : "STALE";
        label.dataset.selected = String(part.selected);
      }
    };
    sync();
    const offset = new T.Vector3(), spherical = new T.Spherical(), projected = new T.Vector3();
    let width = 1, height = 1, frame = 0, last = 0, angle = 0, explode = 0, visible = false, disposed = false, lost = false;
    const animate = (time: number) => {
      frame = 0;
      if (disposed || document.hidden || !visible || lost) return;
      const dt = last ? Math.min((time - last) / 1000, .05) : 0;
      last = time;
      const value = current.current;
      const live = value.connection === "live" && !!value.telemetry;
      if (!reduced.matches && live) angle = (angle + Math.max(0, value.telemetry?.rpm ?? 0) / 60 * Math.PI * 2 * dt * .015) % (Math.PI * 2 * 2.43);
      model.update(angle);
      const target = value.exploded ? 1 : 0;
      explode = reduced.matches ? target : T.MathUtils.damp(explode, target, 8, dt);
      for (let i = 0; i < registry.movable.length; i++) {
        const item = registry.movable[i]; item.mesh.position.copy(item.base).addScaledVector(item.offset, explode);
      }
      const pulse = reduced.matches || !live ? 0 : 1 - Math.abs((time % 1600) / 800 - 1);
      for (let i = 0; i < registry.parts.length; i++) {
        const part = registry.parts[i];
        const monitored = part.state === "NOMINAL" || part.state === "WATCH" || part.state === "CRITICAL";
        for (let j = 0; j < part.materials.length; j++) {
          const material = part.materials[j];
          if (part.selected) { material.emissive.copy(colors.selected); material.emissiveIntensity = .45; }
          else if (monitored && live) { material.emissive.copy(colors[part.state as "NOMINAL" | "WATCH" | "CRITICAL"]); material.emissiveIntensity = part.state === "CRITICAL" ? .3 + pulse * .3 : .15; }
          else { material.emissive.copy(colors.neutral); material.emissiveIntensity = monitored && !live ? .06 : 0; }
        }
      }
      orbit.update(); renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    const resume = () => {
      if (disposed || document.hidden || !visible || lost) { cancelAnimationFrame(frame); frame = 0; last = 0; return; }
      if (!frame) { last = 0; frame = requestAnimationFrame(animate); }
    };
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; resume(); }, { threshold: 0 });
    observer.observe(element);
    const resize = new ResizeObserver(entries => {
      width = Math.max(1, entries[0].contentRect.width); height = Math.max(1, entries[0].contentRect.height);
      renderer.setSize(width, height, false); camera.aspect = width / height;
      camera.fov = width < 420 ? 54 : 42; camera.updateProjectionMatrix();
    });
    resize.observe(element);
    document.addEventListener("visibilitychange", resume);
    const motionPreference = () => { orbit.enableDamping = !reduced.matches; };
    reduced.addEventListener("change", motionPreference);
    // Label layout is throttled outside the allocation-free scene loop; rectangles and vectors are reused.
    const labelTimer = window.setInterval(() => {
      if (document.hidden || !visible || lost) return;
      for (let i = 0; i < labelsDom.length; i++) {
        const item = labelsDom[i];
        projected.copy(item.part.anchor).addScaledVector(item.part.offset, explode).applyMatrix4(model.root.matrixWorld).project(camera);
        item.width = item.button.offsetWidth; item.height = item.button.offsetHeight;
        item.x = (projected.x + 1) * width / 2 - item.width / 2; item.y = (1 - projected.y) * height / 2 - item.height / 2;
        item.visible = current.current.labels && projected.z > -1 && projected.z < 1 && item.x >= 4 && item.y >= 4 && item.x + item.width < width - 4 && item.y + item.height < height - 4;
        for (let j = 0; j < i && item.visible; j++) {
          const other = labelsDom[j];
          if (other.visible && item.x < other.x + other.width + 6 && item.x + item.width + 6 > other.x && item.y < other.y + other.height + 6 && item.y + item.height + 6 > other.y) item.visible = false;
        }
        item.button.style.visibility = item.visible ? "visible" : "hidden";
        if (item.visible) item.button.style.transform = `translate(${item.x}px, ${item.y}px)`;
      }
    }, 120);
    const raycaster = new T.Raycaster(), pointer = new T.Vector2();
    const hits: T.Intersection[] = [];
    let downX = 0, downY = 0;
    const down = (event: PointerEvent) => { downX = event.clientX; downY = event.clientY; };
    const pick = (event: PointerEvent) => {
      if (current.current.role !== "Maintenance Engineer" || event.button !== 0 || Math.hypot(event.clientX - downX, event.clientY - downY) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera); hits.length = 0; raycaster.intersectObjects(registry.pickable, false, hits);
      if (hits[0]) current.current.onSelectPart(hits[0].object.userData.partId);
      hits.length = 0;
    };
    const keydown = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-"].includes(event.key)) return;
      event.preventDefault();
      offset.copy(camera.position).sub(orbit.target); spherical.setFromVector3(offset);
      if (event.key === "ArrowLeft") spherical.theta -= .12;
      if (event.key === "ArrowRight") spherical.theta += .12;
      if (event.key === "ArrowUp") spherical.phi -= .12;
      if (event.key === "ArrowDown") spherical.phi += .12;
      if (event.key === "+" || event.key === "=") spherical.radius *= .9;
      if (event.key === "-") spherical.radius *= 1.1;
      spherical.radius = T.MathUtils.clamp(spherical.radius, orbit.minDistance, orbit.maxDistance); spherical.makeSafe();
      camera.position.copy(orbit.target).add(offset.setFromSpherical(spherical)); orbit.update();
    };
    let initialBeta: number | null = null, initialGamma = 0, lastBeta = 0, lastGamma = 0;
    const orientation = (event: DeviceOrientationEvent) => {
      if (!current.current.motion || event.beta == null || event.gamma == null) { initialBeta = null; return; }
      if (initialBeta === null) { initialBeta = lastBeta = event.beta; initialGamma = lastGamma = event.gamma; setMotionStatus("Motion ready"); return; }
      offset.copy(camera.position).sub(orbit.target); spherical.setFromVector3(offset);
      spherical.theta += T.MathUtils.degToRad(event.gamma - lastGamma) * .6;
      spherical.phi += T.MathUtils.degToRad(event.beta - lastBeta) * .6;
      lastBeta = event.beta; lastGamma = event.gamma;
      spherical.makeSafe(); camera.position.copy(orbit.target).add(offset.setFromSpherical(spherical)); orbit.update();
    };
    const contextLost = (event: Event) => { event.preventDefault(); lost = true; setUnavailable(true); resume(); };
    const contextRestored = () => { lost = false; setUnavailable(false); resume(); };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointerup", pick);
    renderer.domElement.addEventListener("keydown", keydown);
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    renderer.domElement.addEventListener("webglcontextrestored", contextRestored);
    window.addEventListener("deviceorientation", orientation);
    runtime.current = { reset: () => { orbit.reset(); }, update: sync };
    return () => {
      disposed = true; cancelAnimationFrame(frame); clearInterval(labelTimer);
      runtime.current = null; observer.disconnect(); resize.disconnect(); themeObserver.disconnect();
      document.removeEventListener("visibilitychange", resume); reduced.removeEventListener("change", motionPreference);
      window.removeEventListener("deviceorientation", orientation);
      renderer.domElement.removeEventListener("pointerdown", down); renderer.domElement.removeEventListener("pointerup", pick);
      renderer.domElement.removeEventListener("keydown", keydown); renderer.domElement.removeEventListener("webglcontextlost", contextLost); renderer.domElement.removeEventListener("webglcontextrestored", contextRestored);
      orbit.dispose();
      const geometries = new Set<T.BufferGeometry>(), allMaterials = new Set<T.Material>(Object.values(materials)), textures = new Set<T.Texture>();
      scene.traverse(object => { if (object instanceof T.Mesh) { geometries.add(object.geometry); const list = Array.isArray(object.material) ? object.material : [object.material]; for (const material of list) allMaterials.add(material); } });
      for (const material of allMaterials) { for (const value of Object.values(material)) if (value instanceof T.Texture) textures.add(value); material.dispose(); }
      for (const geometry of geometries) geometry.dispose();
      for (const texture of textures) texture.dispose();
      scene.environment = null; environment.dispose(); scene.clear(); renderer.renderLists.dispose(); renderer.dispose(); renderer.forceContextLoss();
      renderer.domElement.remove(); layer.replaceChildren();
    };
  }, []);

  const enableMotion = async () => {
    if (motion) { setMotion(false); setMotionStatus(""); return; }
    const orientation = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> };
    if (!orientation) { setMotionStatus("Device motion is unavailable on this device."); return; }
    try {
      if (orientation.requestPermission && await orientation.requestPermission() !== "granted") { setMotionStatus("Motion permission was not granted. Drag or use the arrow keys instead."); return; }
      setMotion(true); setMotionStatus("Motion enabled; waiting for device orientation.");
    } catch { setMotionStatus("Motion permission is unavailable. Drag to rotate instead."); }
  };
  const timestamp = telemetry ? Date.parse(telemetry.ts) : NaN;
  const age = Number.isFinite(timestamp) ? `${Math.max(0, Math.floor((now - timestamp) / 1000))} s ago` : "—";
  const gate = roleGate(role, "Maintenance Engineer");
  return <section className="panel twin-viewport" aria-label="Live engine digital twin" data-connection={connection}>
    <header className="twin-toolbar"><span className="section-label">TELEMETRY-LINKED GEOMETRY</span><div>
      <button type="button" onClick={() => setLabels(!labels)} aria-pressed={labels}><Tag size={14} />Labels</button>
      <button type="button" onClick={enableMotion} aria-pressed={motion}><Smartphone size={14} />Motion</button>
      <button type="button" onClick={() => runtime.current?.reset()}><RotateCcw size={14} />Reset view</button>
    </div></header>
    {connection !== "live" && <p className="twin-stale" role="status"><AlertTriangle size={14} />Stale data - last update {age}</p>}
    {motionStatus && <p className="twin-hint" role="status">{motionStatus}</p>}
    {intro && <div className="twin-intro"><span><Hand size={15} />Drag to rotate</span><span><MousePointer2 size={15} />Click a part</span><span><CheckCircle2 size={15} />Colours = live health</span><button type="button" aria-label="Dismiss engine introduction" onClick={() => { setIntro(false); try { sessionStorage.setItem("aerotwin.engine-intro", "dismissed"); } catch {} }}><X size={15} /></button></div>}
    <div className="twin-canvas-wrap">
      <div ref={host} className="twin-canvas" title={role === "Operator" ? "Only Engineer can do this" : undefined} />
      <div className="twin-labels" ref={labelLayer} />
      {unavailable && <div className="twin-fallback" role="status"><CircleHelp size={28} /><strong>The 3D view is unavailable</strong><p>Your browser could not start WebGL. Live readings and the Parts list below still work.</p></div>}
    </div>
    <div className="twin-legend" aria-label="Health colour legend"><span data-state="NOMINAL"><CheckCircle2 size={12} />Green · nominal</span><span data-state="WATCH"><AlertTriangle size={12} />Amber · watch</span><span data-state="CRITICAL"><AlertTriangle size={12} />Red · critical</span><span><CircleHelp size={12} />Grey · no sensor</span><span className="twin-selected"><MousePointer2 size={12} />Cyan · selected</span></div>
    <p className="twin-hint">Drag to rotate · pinch or scroll to zoom · right-drag to pan · arrow keys rotate, +/− zoom. {role === "Operator" ? "Only Engineer can do this: select a part for diagnostics." : "Select a mesh or a part below to inspect its readings."}</p>
    <div className="twin-sheet">
      <div className="twin-tabs" role="tablist" aria-label="Engine information">{(["health", "parts", "alerts"] as const).map(name => <button key={name} id={`twin-tab-${name}`} type="button" role="tab" aria-selected={tab === name} aria-controls={`twin-panel-${name}`} onClick={() => setTab(name)}>{name === "health" ? "Live health" : name === "parts" ? "Parts" : "Faults & advisories"}</button>)}</div>
      <div role="tabpanel" id={`twin-panel-${tab}`} aria-labelledby={`twin-tab-${tab}`}>
        {tab === "health" && <dl className="twin-hud">{readings.map(reading => <div key={reading.source}><dt>{reading.label}</dt><dd data-source={reading.source}>{formatReading(reading.value, reading.digits)}<small>{reading.value == null ? "" : reading.unit}</small></dd></div>)}</dl>}
        {tab === "parts" && <div className="twin-parts">{parts.map(part => <RoleControl key={part.id} role={role} required="Maintenance Engineer"><button type="button" className="twin-part-row" aria-pressed={selectedPartId === part.id} onClick={() => onSelectPart(part.id)} {...gate}><span>{part.label}</span><PartStatus state={part.state} stale={connection !== "live"} /></button></RoleControl>)}</div>}
        {tab === "alerts" && <div className="twin-alerts">{!telemetry ? <p>—</p> : <><h4>Faults</h4>{telemetry.faults.length ? telemetry.faults.map((fault, i) => <p key={`${fault.type}-${i}`}><strong>{fault.severity} · {fault.type}</strong><br />{fault.detail}</p>) : <p>No faults in this sample.</p>}<h4>Advisories</h4>{telemetry.advisories.length ? telemetry.advisories.map((advisory, i) => <p key={`${advisory.component}-${i}`}><strong>{advisory.urgency} · {advisory.component}</strong><br />{advisory.action}<br />{advisory.evidence}</p>) : <p>No advisories in this sample.</p>}</>}</div>}
      </div>
    </div>
    {selected && <EnginePartInfo part={selected} connection={connection} />}
  </section>;
}
