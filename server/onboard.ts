import { createEngineSimulator } from "./engine-simulator";
import { createOnboardPipeline, TICK_INTERVAL_MS } from "./onboard-pipeline";
import { parseControls } from "./telemetry-controls";
import { createLinkSender, linkKey } from "./link-security";

const url = process.env.AEROTWIN_GROUND_URL || "http://127.0.0.1:3001";
const target = new URL("/internal/telemetry", url);
if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname) && target.protocol !== "https:") {
  throw new Error("Remote ground links require HTTPS; do not send telemetry over plaintext networks");
}
const send = createLinkSender(linkKey());
const pipeline = createOnboardPipeline(createEngineSimulator());
const controls = parseControls({});
let stopped = false;
let failures = 0;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });

async function tick() {
  const { body, signature } = send(pipeline.next(controls));
  try {
    const response = await fetch(target, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Telemetry-Signature": signature },
      body, signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`Ground rejected telemetry (${response.status})`);
    failures = 0;
  } catch (error) {
    if (++failures === 1 || failures % 30 === 0) console.error("Onboard link unavailable:", error);
  }
}

console.log(`Onboard simulator sending reduced signed telemetry to ${target.origin}`);
while (!stopped) {
  const started = Date.now();
  await tick();
  await new Promise(resolve => setTimeout(resolve, Math.max(0, TICK_INTERVAL_MS - (Date.now() - started))));
}
