import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OnboardPayload } from "./onboard-pipeline";

export type LinkEnvelope = { source: string; sequence: number; sentAt: number; payload: OnboardPayload };
const MAX_AGE_MS = 30_000;

export function linkKey() {
  const key = process.env.AEROTWIN_LINK_KEY;
  if (!key || key.length < 32) throw new Error("AEROTWIN_LINK_KEY must be a random secret of at least 32 characters");
  return key;
}

export function signEnvelope(envelope: LinkEnvelope, key: string) {
  const body = JSON.stringify(envelope);
  const signature = createHmac("sha256", key).update(body).digest("hex");
  return { body, signature };
}

export function createLinkSender(key: string, source = randomUUID()) {
  let sequence = 0;
  return (payload: OnboardPayload) => signEnvelope({ source, sequence: ++sequence, sentAt: Date.now(), payload }, key);
}

export function ensureLinkSchema(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS link_sequences (source TEXT PRIMARY KEY, sequence INTEGER NOT NULL, last_seen INTEGER NOT NULL)");
}

/** Authenticate the exact bytes received before parsing, then atomically advance the replay cursor. */
export function verifyEnvelope(body: string, signature: string | undefined, key: string, db: DatabaseSync, now = Date.now()): LinkEnvelope {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) throw new Error("Missing or invalid signature");
  const expected = createHmac("sha256", key).update(body).digest();
  if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) throw new Error("Invalid signature");
  const envelope = JSON.parse(body) as LinkEnvelope;
  if (!envelope || typeof envelope !== "object" || typeof envelope.source !== "string" ||
      !/^[0-9a-f-]{36}$/.test(envelope.source) || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 ||
      !Number.isFinite(envelope.sentAt) || Math.abs(now - envelope.sentAt) > MAX_AGE_MS ||
      !envelope.payload || typeof envelope.payload !== "object" ||
      !Number.isFinite(envelope.payload.signals?.rpm) ||
      !Number.isFinite(envelope.payload.physics?.residualScore) ||
      !Number.isFinite(envelope.payload.sample?.t) ||
      !Array.isArray(envelope.payload.immediateFaults) || envelope.payload.immediateFaults.length > 16 ||
      !Array.isArray(envelope.payload.physics?.residuals?.egt) || envelope.payload.physics.residuals.egt.length !== 4 ||
      !Array.isArray(envelope.payload.physics?.residuals?.cht) || envelope.payload.physics.residuals.cht.length !== 4 ||
      !Number.isFinite(Date.parse(envelope.payload.ts)) || Math.abs(now - Date.parse(envelope.payload.ts)) > MAX_AGE_MS) {
    throw new Error("Invalid or expired telemetry envelope");
  }
  const result = db.prepare(`INSERT INTO link_sequences (source, sequence, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET sequence = excluded.sequence, last_seen = excluded.last_seen
    WHERE excluded.sequence > link_sequences.sequence`).run(envelope.source, envelope.sequence, now);
  if (result.changes !== 1) throw new Error("Replayed or out-of-order telemetry");
  return envelope;
}
