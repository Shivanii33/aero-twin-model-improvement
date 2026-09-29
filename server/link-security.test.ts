import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createEngineSimulator } from "./engine-simulator";
import { createOnboardPipeline } from "./onboard-pipeline";
import { createLinkSender, ensureLinkSchema, signEnvelope, verifyEnvelope } from "./link-security";

const controls = { rpm: 5203, map: 0.84, altitude: 8200, cylinderBias: 0, ambientC: 15 };
const key = "test-only-key-with-at-least-32-characters";
const source = "5c7e8494-a332-41bb-8ef1-c5e1f9d44bef";

test("signed onboard envelopes reject tampering, replays, stale data and out-of-order messages", () => {
  const db = new DatabaseSync(":memory:");
  ensureLinkSchema(db);
  const sender = createLinkSender(key, source);
  const onboard = createOnboardPipeline(createEngineSimulator());
  const first = sender(onboard.next(controls));
  assert.equal(verifyEnvelope(first.body, first.signature, key, db).sequence, 1);
  assert.throws(() => verifyEnvelope(first.body, first.signature, key, db), /Replayed/);
  const second = sender(onboard.next(controls));
  assert.throws(() => verifyEnvelope(second.body + " ", second.signature, key, db), /signature/);
  assert.equal(verifyEnvelope(second.body, second.signature, key, db).sequence, 2);
  const old = signEnvelope({ source, sequence: 3, sentAt: Date.now() - 40_000, payload: onboard.next(controls) }, key);
  assert.throws(() => verifyEnvelope(old.body, old.signature, key, db), /expired/);
  const outOfOrder = signEnvelope({ source, sequence: 1, sentAt: Date.now(), payload: onboard.next(controls) }, key);
  assert.throws(() => verifyEnvelope(outOfOrder.body, outOfOrder.signature, key, db), /Replayed/);
  db.close();
});
