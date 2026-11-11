// Tema tercihi: "system" işletim sisteminin açık/koyu ayarını izler. Tercih sadece bu tarayıcıda saklanır.
export type Theme = "system" | "light" | "dark" | "blue";
const KEY = "sre-portal:theme";

export function getTheme(): Theme {
  try { return (localStorage.getItem(KEY) as Theme) || "system"; } catch { return "system"; }
}

export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", t);
  try { localStorage.setItem(KEY, t); } catch { /* özel pencere */ }
}
