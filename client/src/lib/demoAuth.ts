import { createContext, useContext } from "react";

export type DemoRole = "Operator" | "Maintenance Engineer";
export type DemoUser = { username: string; displayName: string; role: DemoRole };

// Localhost prototype only. Client-side demo accounts: no server session, cookie, token or database.
const DEMO_ACCOUNTS: ReadonlyArray<DemoUser & { password: string }> = [
  { username: "operator", password: "operator123", displayName: "Flight Operator", role: "Operator" },
  { username: "engineer", password: "engineer123", displayName: "Maintenance Engineer", role: "Maintenance Engineer" },
];

export const DEMO_ACCOUNTS_DISPLAY = DEMO_ACCOUNTS.map(({ username, password, displayName, role }) => ({ username, password, displayName, role }));
const SESSION_KEY = "aerotwin-demo-user";

export function authenticateDemo(username: string, password: string): DemoUser | null {
  const account = DEMO_ACCOUNTS.find(a => a.username === username.trim().toLowerCase() && a.password === password);
  return account ? { username: account.username, displayName: account.displayName, role: account.role } : null;
}

export function readDemoUser(): DemoUser | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as DemoUser;
    const known = DEMO_ACCOUNTS.find(a => a.username === u.username && a.role === u.role);
    return known ? { username: known.username, displayName: known.displayName, role: known.role } : null;
  } catch { return null; }
}
export function saveDemoUser(user: DemoUser) {
  try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ username: user.username, displayName: user.displayName, role: user.role })); } catch { /* storage blocked: session lasts until refresh */ }
}
export function clearDemoUser() {
  try { window.sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).map(p => p[0]).join("").slice(0, 2).toUpperCase();
}

/** Props for a role-gated button: disabled + tooltip when the current role is not allowed. */
export function roleGate(current: DemoRole, required: DemoRole) {
  if (current === required) return {};
  return { disabled: true, "aria-disabled": true } as const;
}

export const DemoAuthContext = createContext<{ user: DemoUser; signOut: () => void } | null>(null);
export function useDemoAuth() {
  const ctx = useContext(DemoAuthContext);
  if (!ctx) throw new Error("useDemoAuth must be used inside AuthGate");
  return ctx;
}
