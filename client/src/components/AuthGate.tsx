import { useState, type FormEvent, type ReactNode } from "react";
import useSWR from "swr";

type AuthStatus = { required: boolean; role: "operator" | "maintenance" | null };

export default function AuthGate({ children }: { children: ReactNode }) {
  const { data, mutate } = useSWR<AuthStatus>("/api/auth/status", async (url: string) => {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error("Unable to check API access");
    return response.json();
  });
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  if (!data) return <main style={{ padding: "3rem", color: "#e9f3f0" }}>Connecting to AeroTwin ground station...</main>;
  if (!data.required || data.role) return <>{children}</>;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const response = await fetch("/api/auth/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error("Invalid access token");
      setToken("");
      await mutate();
    } catch { setError("Invalid access token. Ask your administrator for an operator or maintenance token."); }
  }
  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#091914", color: "#e9f3f0", padding: 24 }}>
    <form onSubmit={submit} style={{ width: "min(100%, 420px)", display: "grid", gap: 16, padding: 32, border: "1px solid #416254", borderRadius: 16, background: "#10241d" }}>
      <h1 style={{ fontSize: 28, margin: 0 }}>AeroTwin ground access</h1>
      <p style={{ margin: 0, color: "#b8cec3" }}>Enter your operator or maintenance access token. It is exchanged for an eight-hour, HttpOnly session cookie.</p>
      <label htmlFor="access-token">Access token</label>
      <input id="access-token" type="password" autoComplete="off" required value={token} onChange={event => setToken(event.target.value)} style={{ padding: 12, borderRadius: 8, color: "#10241d" }} />
      {error && <p role="alert" style={{ color: "#ffb6a4" }}>{error}</p>}
      <button type="submit" style={{ padding: 12, borderRadius: 8, background: "#bcf3a5", color: "#10241d", fontWeight: 700 }}>Sign in</button>
    </form>
  </main>;
}
