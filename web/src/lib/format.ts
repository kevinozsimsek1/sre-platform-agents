const TZ = "Europe/Istanbul";
const dt = new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dOnly = new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, day: "numeric", month: "short" });
const tOnly = new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const full = new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const num = new Intl.NumberFormat("tr-TR");

export const fmtDateTime = (ms?: number | null) => (ms ? dt.format(ms) : "—");
export const fmtDate = (ms?: number | string | null) => (ms ? dOnly.format(typeof ms === "string" ? new Date(ms + "T12:00:00Z") : ms) : "—");
export const fmtTime = (ms?: number | null) => (ms ? tOnly.format(ms) : "—");
export const fmtFull = (ms?: number | null) => (ms ? full.format(ms) : "—");
export const fmtNum = (n?: number | null) => (n == null ? "—" : num.format(Math.round(n)));

export function fmtMin(m?: number | null): string {
  if (m == null) return "—";
  if (m < 1) return "<1 dk";
  if (m < 60) return `${Math.round(m)} dk`;
  if (m < 1440) return `${Math.floor(m / 60)} sa ${Math.round(m % 60)} dk`;
  return `${Math.floor(m / 1440)} g ${Math.round((m % 1440) / 60)} sa`;
}

export function fmtPct(x?: number | null, digits = 2): string {
  if (x == null) return "—";
  return "%" + (x * 100).toLocaleString("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function ago(ms?: number | null): string {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "az önce";
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return `${Math.floor(s / 86400)} gün önce`;
}
