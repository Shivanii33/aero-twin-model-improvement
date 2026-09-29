export type ReplayPoint = {
  time: number;
  label: string;
  actual: number;
  baseline: number;
  residual: number;
  ts: string;
  health: number;
  rul: number;
  fuelFlow: number;
  rpm: number;
  powerKw: number;
  sfc: number | null;
};
export type AttentionFrame = { time: number; head: number; weight: number };
export type FlightLog = {
  id: string;
  mission: string;
  date: string;
  duration: string;
  aircraft: string;
  data: ReplayPoint[];
  attention: AttentionFrame[];
  sampleCount: number;
  reportNotes: string;
};
const PREFERENCES_KEY = "aerotwin.preferences.v1";
type Preferences = { theme: "dark" | "light"; lastReplayId: string };
function readPreferences(): Preferences {
  try {
    return { theme: "dark", lastReplayId: "", ...JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) || "{}") };
  } catch { return { theme: "dark", lastReplayId: "" }; }
}
export function getThemePreference(): "dark" | "light" { return readPreferences().theme; }
export function saveThemePreference(theme: "dark" | "light") {
  try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ...readPreferences(), theme })); } catch { /* Optional display preference. */ }
}
export function getLastReplayId() { return readPreferences().lastReplayId; }
export function saveLastReplayId(lastReplayId: string) {
  try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ...readPreferences(), lastReplayId })); } catch { /* Optional display preference. */ }
}
