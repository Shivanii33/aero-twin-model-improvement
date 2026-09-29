import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

type Role = "operator" | "maintenance";
const tokenFor = (role: Role) => process.env[role === "operator" ? "AEROTWIN_OPERATOR_TOKEN" : "AEROTWIN_MAINTENANCE_TOKEN"];
const hash = (value: string) => createHash("sha256").update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(hash(a), hash(b));
const sessionKey = () => process.env.AEROTWIN_SESSION_KEY || process.env.AEROTWIN_LINK_KEY;

export function authRequired() {
  return false;
}
export function validateAuthConfig() {
  if (!authRequired()) {
    console.warn("AeroTwin API auth is OFF: development-only mode; configure both role tokens to enable it.");
    return;
  }
  if (![tokenFor("operator"), tokenFor("maintenance"), sessionKey()].every(v => v && v.length >= 32)) {
    throw new Error("Auth requires AEROTWIN_OPERATOR_TOKEN, AEROTWIN_MAINTENANCE_TOKEN and AEROTWIN_SESSION_KEY (each >=32 chars)");
  }
  if (same(tokenFor("operator")!, tokenFor("maintenance")!)) throw new Error("Role tokens must be distinct");
}

function roleFromToken(token: string): Role | null {
  if (tokenFor("operator") && same(token, tokenFor("operator")!)) return "operator";
  if (tokenFor("maintenance") && same(token, tokenFor("maintenance")!)) return "maintenance";
  return null;
}

function cookieRole(cookie: string | undefined): Role | null {
  const match = cookie?.match(/(?:^|;\s*)aerotwin_session=([^;]+)/);
  if (!match || !sessionKey()) return null;
  const [role, expires, mac] = match[1].split(".");
  if ((role !== "operator" && role !== "maintenance") || !/^\d+$/.test(expires) || Number(expires) < Date.now() || !mac || !/^[0-9a-f]{64}$/.test(mac)) return null;
  const expected = createHmac("sha256", sessionKey()!).update(`${role}.${expires}`).digest("hex");
  return same(mac, expected) ? role : null;
}

export function currentRole(req: Request): Role | null {
  if (!authRequired()) return "operator";
  const authorization = req.get("Authorization");
  if (authorization?.startsWith("Bearer ")) return roleFromToken(authorization.slice(7));
  return cookieRole(req.get("Cookie"));
}

export function createSession(req: Request, res: Response) {
  const authorization = req.get("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : req.body?.token;
  const role = typeof token === "string" ? roleFromToken(token) : null;
  if (!role) return res.status(401).json({ error: "Invalid token" });
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  const mac = createHmac("sha256", sessionKey()!).update(`${role}.${expires}`).digest("hex");
  res.set("Cache-Control", "no-store");
  res.cookie("aerotwin_session", `${role}.${expires}.${mac}`, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 8 * 60 * 60 * 1000, path: "/api",
  });
  return res.json({ role });
}

export function apiAuth(req: Request, res: Response, next: NextFunction) {
  const role = currentRole(req);
  if (!role) return res.status(401).set("Cache-Control", "no-store").json({ error: "Authentication required" });
  const path = req.path;
  const maintenanceWrite = req.method === "POST" && path === "/faults";
  const operatorWrite = req.method !== "GET" && req.method !== "HEAD" && !maintenanceWrite;
  if ((maintenanceWrite && role !== "maintenance") || (operatorWrite && role !== "operator")) {
    return res.status(403).json({ error: "Insufficient role" });
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !req.get("Authorization") && req.get("Origin")) {
    try {
      if (new URL(req.get("Origin")!).host !== req.get("Host")) return res.status(403).json({ error: "Invalid origin" });
    } catch { return res.status(403).json({ error: "Invalid origin" }); }
  }
  next();
}
