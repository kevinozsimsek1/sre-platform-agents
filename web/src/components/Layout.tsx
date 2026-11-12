import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BellRing, Bot, Gauge, LockKeyhole, Search, Siren, Target, Wallet } from "lucide-react";
import { api } from "../lib/api";
import { track } from "../lib/audit";
import CommandPalette from "./CommandPalette";
import { applyTheme, getTheme, type Theme } from "../lib/theme";

type NavItem = { to: string; label: string; icon: ReactNode; badge?: "firing" | "open" | "slo" };

const NAV: NavItem[] = [
  { to: "/", label: "Genel bakış", icon: <Gauge size={16} /> },
  { to: "/alerts", label: "Gelen alert'ler", icon: <BellRing size={16} />, badge: "firing" },
  { to: "/incidents", label: "Olaylar ve analiz", icon: <Siren size={16} />, badge: "open" },
  { to: "/slo", label: "SLO ve hata bütçesi", icon: <Target size={16} />, badge: "slo" },
  { to: "/value", label: "Maliyet ve değer", icon: <Wallet size={16} /> },
];

const AGENTS = [
  { href: "/cloudwatch/", label: "CloudWatch agent" },
  { href: "/eks/", label: "EKS agent" },
];

const link = "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors";


const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "Sistem" },
  { id: "light", label: "Açık" },
  { id: "dark", label: "Koyu" },
  { id: "blue", label: "Mavi" },
];

function ThemePicker() {
  const [t, setT] = useState<Theme>(getTheme());
  return (
    <div className="flex flex-col gap-1.5 px-2.5">
      <span className="text-[11px] font-semibold tracking-wider text-ink-3 uppercase">Tema</span>
      <div className="grid grid-cols-4 gap-1 rounded-md bg-edge-soft p-1" role="radiogroup" aria-label="Tema">
        {THEMES.map((x) => (
          <button
            key={x.id}
            type="button"
            role="radio"
            aria-checked={t === x.id}
            onClick={() => { applyTheme(x.id); setT(x.id); }}
            className={`rounded px-1 py-1 text-[12px] ${t === x.id ? "bg-panel font-medium text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
          >
            {x.label}
          </button>
        ))}
      </div>
    </div>
  );
}

type Counts = { firing: { severity: string | null }[]; incidents_24h: { ongoing: boolean }[]; slo: { breached: number } };

/** Menüdeki sayaçlar: şu an alarmdaki kural, açık olay ve SLO'su aşılan servis sayısı. */
function useBadges() {
  const q = useQuery<Counts>({ queryKey: ["overview"], queryFn: () => api("/overview"), refetchInterval: 120_000 });
  if (!q.data) return {};
  return {
    firing: { n: q.data.firing.length, crit: q.data.firing.some((f) => f.severity === "critical"), title: "şu an alarmdaki kural" },
    open: { n: q.data.incidents_24h.filter((i) => i.ongoing).length, crit: true, title: "açık olay" },
    slo: { n: q.data.slo.breached, crit: true, title: "SLO hedefini aşan servis" },
  } as Record<string, { n: number; crit: boolean; title: string }>;
}

export default function Layout() {
  const loc = useLocation();
  const badges = useBadges();
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    track({ type: "page_view", page: loc.pathname, target: loc.pathname });
    window.scrollTo(0, 0);
  }, [loc.pathname]);

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="min-w-0 border-b border-edge bg-panel md:sticky md:top-0 md:flex md:h-screen md:w-64 md:shrink-0 md:flex-col md:border-r md:border-b-0">
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-4 md:py-6">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-md bg-ink font-mono text-[12px] font-medium text-canvas">SRE</span>
            <div className="leading-tight">
              <div className="text-sm font-semibold">Nebim SRE Portal</div>
              <div className="text-xs text-ink-3">Prod gözlem merkezi</div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setPalette(true)}
            className="hidden items-center gap-2 rounded-md border border-edge bg-canvas px-2.5 py-1.5 text-[13px] text-ink-3 hover:text-ink md:flex"
          >
            <Search size={14} /> <span className="flex-1 text-left">Ara</span>
            <kbd className="rounded border border-edge px-1 font-mono text-[10.5px]">{navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"}</kbd>
          </button>

          <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible" aria-label="Portal">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => `${link} ${isActive ? "bg-accent-soft font-medium text-accent" : "text-ink-2 hover:bg-edge-soft hover:text-ink"}`}
              >
                {item.icon}
                {item.label}
                {item.badge && badges[item.badge]?.n > 0 && (
                  <span
                    title={`${badges[item.badge].n} ${badges[item.badge].title}`}
                    className={`ml-auto rounded-full px-1.5 py-px font-mono text-[11px] font-semibold tabular-nums ${badges[item.badge].crit ? "bg-crit-soft text-crit" : "bg-warn-soft text-warn"}`}
                  >
                    {badges[item.badge].n}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="hidden flex-col gap-1 md:flex">
            <div className="px-2.5 text-[11px] font-semibold tracking-wider text-ink-3 uppercase">Agent sohbetleri</div>
            {AGENTS.map((a) => (
              <a key={a.href} href={a.href} className={`${link} text-ink-2 hover:bg-edge-soft hover:text-ink`}>
                <Bot size={16} /> {a.label}
              </a>
            ))}
          </div>

          <div className="mt-auto hidden flex-col gap-2 border-t border-edge-soft pt-4 md:flex">
            <ThemePicker />
            <NavLink to="/admin" className={({ isActive }) => `${link} ${isActive ? "bg-accent-soft font-medium text-accent" : "text-ink-3 hover:bg-edge-soft hover:text-ink"}`}>
              <LockKeyhole size={16} /> Denetim kaydı
            </NavLink>
            <p className="px-2.5 pt-1 text-[11.5px] leading-snug text-ink-3">Kaynaklar: Grafana, Prometheus, Tempo, CloudWatch · eu-central-1</p>
          </div>
        </div>
      </aside>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />

      <main className="min-w-0 flex-1 px-4 py-7 md:px-9">
        <div className="mx-auto flex max-w-6xl flex-col gap-9">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
