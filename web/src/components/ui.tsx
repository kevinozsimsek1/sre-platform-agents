import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { ago } from "../lib/format";

export type Tone = "crit" | "warn" | "good" | "mute" | "accent";

const TONE: Record<Tone, string> = {
  crit: "bg-crit-soft text-crit",
  warn: "bg-warn-soft text-warn",
  good: "bg-good-soft text-good",
  mute: "bg-edge-soft text-ink-2",
  accent: "bg-accent-soft text-accent",
};

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-px text-[11.5px] font-semibold ${TONE[tone]}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

export function Severity({ value }: { value?: string | null }) {
  if (value === "critical") return <Pill tone="crit">critical</Pill>;
  if (value === "warning") return <Pill tone="warn">warning</Pill>;
  return <Pill tone="mute">{value || "—"}</Pill>;
}

export const FINDING: Record<string, { label: string; tone: Tone }> = {
  broken: { label: "Bozuk", tone: "crit" },
  nodata: { label: "Veri yok", tone: "warn" },
  flapping: { label: "Dalgalı", tone: "warn" },
  scheduled: { label: "Zamanlı", tone: "warn" },
  duplicate: { label: "Kopya", tone: "warn" },
  long_open: { label: "Uzun süredir açık", tone: "warn" },
  severity: { label: "Seviye uyumsuz", tone: "mute" },
  copy: { label: "Kopya adı", tone: "mute" },
  offhours: { label: "Mesai dışı", tone: "mute" },
  paused: { label: "Duraklatılmış", tone: "mute" },
};

export function FindingPill({ code }: { code: string }) {
  const f = FINDING[code] ?? { label: code, tone: "mute" as Tone };
  return <Pill tone={f.tone}>{f.label}</Pill>;
}

/** Bir rakamın yanındaki ⓘ: basınca "bu nasıl hesaplandı" açıklaması açılır.
 *  Kutu `fixed` konumlanır; tablo gibi yatay kaydırmalı kapsayıcılar içinde kırpılmaması
 *  ve dar ekranda taşmaması için konumu düğmenin yerine göre hesaplanıp ekrana sığdırılır. */
export function Info({ title, children, align = "left" }: { title: string; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect();
    if (!b) return;
    const pad = 12;
    const width = Math.min(360, window.innerWidth - pad * 2);
    let left = align === "right" ? b.right - width : b.left;
    left = Math.min(Math.max(pad, left), window.innerWidth - width - pad);
    const h = box.current?.offsetHeight ?? 180;
    const below = window.innerHeight - b.bottom;
    const top = below > h + pad ? b.bottom + 6 : Math.max(pad, b.top - h - 6);
    setPos({ left, top, width });
  }, [align]);

  useEffect(() => {
    if (!open) return;
    place();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return (
    <>
      <button ref={btn} type="button" aria-expanded={open} aria-label={`${title} — nasıl hesaplandı`}
        onClick={() => setOpen((v) => !v)}
        className={`grid size-[18px] shrink-0 place-items-center rounded-full border text-[11px] font-semibold ${open ? "border-accent bg-accent text-white" : "border-edge text-ink-3 hover:border-accent hover:text-accent"}`}>
        i
      </button>
      {open && (
        <div ref={box} role="dialog" aria-label={title}
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: pos?.width ?? 320 }}
          className="fixed z-50 flex flex-col gap-2 rounded-lg border border-edge bg-panel p-3.5 text-left font-sans text-[13px] font-normal tracking-normal normal-case shadow-2xl">
          <span className="text-[13px] font-semibold text-ink">{title}</span>
          <span className="leading-relaxed text-ink-2">{children}</span>
          <button type="button" onClick={() => setOpen(false)} className="w-fit text-[12.5px] font-medium text-accent">Kapat</button>
        </div>
      )}
    </>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-w-0 rounded-lg border border-edge bg-panel ${className}`}>{children}</div>;
}

export function PageHeader({ eyebrow, title, children, actions }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 border-b border-edge pb-6">
      {eyebrow && <div className="text-xs font-semibold tracking-wider text-ink-3 uppercase">{eyebrow}</div>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 text-[26px] leading-tight font-bold tracking-tight">{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function Section({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {aside && <div className="text-[13px] text-ink-2">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Stat({ value, label, tone, hint }: { value: ReactNode; label: ReactNode; tone?: "crit" | "warn" | "good"; hint?: ReactNode }) {
  const color = tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : tone === "good" ? "text-good" : "";
  return (
    <Panel className="flex h-full flex-col gap-1 px-4 py-3.5 transition-colors group-hover:border-accent">
      <span className={`text-[26px] font-semibold tracking-tight tabular-nums ${color}`}>{value}</span>
      <span className="text-[13px] leading-snug text-ink-2">{label}</span>
      {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
    </Panel>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-edge-soft px-1.5 py-px font-mono text-[0.86em] break-words">{children}</code>;
}

/** Sayfa yüklenirken sayfanın iskeletini gösterir; inline=true ise küçük bir yükleniyor satırı. */
export function Loading({ label = "Yükleniyor", inline = false }: { label?: string; inline?: boolean }) {
  if (inline) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-ink-3" role="status">
        <Loader2 size={16} className="animate-spin" /> {label}…
      </div>
    );
  }
  const block = "rounded-lg bg-edge-soft";
  return (
    <div className="flex flex-col gap-8" role="status" aria-label={label}>
      <div className="flex flex-col gap-3 border-b border-edge pb-6 motion-safe:animate-pulse">
        <div className={`${block} h-3 w-28`} />
        <div className={`${block} h-7 w-72`} />
        <div className={`${block} h-4 w-full max-w-xl`} />
      </div>
      <div className="grid grid-cols-2 gap-3 motion-safe:animate-pulse lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className={`${block} h-24`} />)}
      </div>
      <div className="grid gap-4 motion-safe:animate-pulse lg:grid-cols-2">
        <div className={`${block} h-56`} /><div className={`${block} h-56`} />
      </div>
      <p className="flex items-center gap-2 text-[13px] text-ink-3"><Loader2 size={14} className="animate-spin" /> {label}…</p>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <Panel className="flex items-start gap-3 border-crit/40 p-4 text-sm">
      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-crit" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium">Veri alınamadı</span>
        <span className="break-words text-ink-2">{msg}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="mt-1 w-fit text-[13px] font-medium text-accent">Tekrar dene</button>
        )}
      </div>
    </Panel>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-edge px-4 py-6 text-center text-sm text-ink-3">{children}</div>;
}

export function Freshness({ at, onRefresh, busy }: { at?: number; onRefresh: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-panel px-2.5 py-1 text-[12.5px] text-ink-2 hover:text-ink disabled:opacity-60"
      title="Grafana'dan yeniden çek"
    >
      <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
      {at ? `Güncellendi: ${ago(at)}` : "Yenile"}
    </button>
  );
}

export function Bar({ value, tone = "accent", max = 1 }: { value: number; tone?: "accent" | "crit" | "warn" | "good"; max?: number }) {
  const w = Math.max(0, Math.min(1, value / max)) * 100;
  const c = { accent: "bg-accent", crit: "bg-crit", warn: "bg-warn", good: "bg-good" }[tone];
  return (
    <span className="inline-block h-1.5 w-full min-w-10 overflow-hidden rounded-full bg-edge-soft align-middle">
      <span className={`block h-full rounded-full ${c}`} style={{ width: `${w}%` }} />
    </span>
  );
}

export const th = "px-3 py-2.5 text-left text-[11px] font-semibold tracking-wider text-ink-3 uppercase whitespace-nowrap";
export const thr = th.replace("text-left", "text-right");
export const td = "px-3 py-2.5 align-top";
export const tdn = "px-3 py-2.5 text-right font-mono text-[12.5px] tabular-nums whitespace-nowrap align-top";
