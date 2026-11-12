import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BellRing, CornerDownLeft, FileText, Search, Siren, Target } from "lucide-react";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import type { Incident, Summary, SloService } from "../lib/types";

type Item = { group: string; label: string; hint?: string; to: string; icon: React.ReactNode; text: string };

const PAGES: Item[] = [
  { to: "/", label: "Genel bakış" },
  { to: "/alerts", label: "Gelen alert'ler" },
  { to: "/incidents", label: "Olaylar ve analiz" },
  { to: "/changes", label: "Değişiklikler (deploy ve restart)" },
  { to: "/slo", label: "Servis hedefleri (SLO)" },
  { to: "/value", label: "Maliyet ve değer" },
  { to: "/admin", label: "Yönetim (denetim kaydı, servis hedefleri)" },
].map((p) => ({ ...p, group: "Sayfalar", icon: <FileText size={15} />, text: p.label }));

const norm = (s: string) => s.toLocaleLowerCase("tr").replace(/\s+/g, " ");

/** ⌘K / Ctrl+K / "/" ile açılan hızlı arama: kural, servis, olay ve sayfalara atlar. */
export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const summary = useQuery<Summary>({ queryKey: ["summary"], queryFn: () => api("/alerts/summary"), enabled: open });
  const slo = useQuery<{ services: SloService[] }>({ queryKey: ["slo"], queryFn: () => api("/slo"), enabled: open });
  const inc = useQuery<{ items: Incident[] }>({ queryKey: ["incidents"], queryFn: () => api("/incidents"), enabled: open });

  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  const all = useMemo<Item[]>(() => [
    ...PAGES,
    ...(summary.data?.rules ?? []).map((r) => ({
      group: "Alert kuralları", label: r.title, hint: `${r.severity ?? ""} · ${r.folder}`, to: `/alerts/${r.org}/${r.uid}`,
      icon: <BellRing size={15} />, text: norm(`${r.title} ${r.folder} ${r.group}`),
    })),
    ...(slo.data?.services ?? []).map((s) => ({
      group: "Servisler (SLO)", label: s.service, hint: s.status === "breached" ? "hedef aşıldı" : s.status === "low_traffic" ? "az trafik" : "hedefte",
      to: `/slo/${encodeURIComponent(s.service)}`, icon: <Target size={15} />, text: norm(s.service),
    })),
    ...(inc.data?.items ?? []).slice(0, 40).map((i) => ({
      group: "Son olaylar", label: i.rules.map((r) => r.title).join(", "), hint: fmtDateTime(i.start), to: `/incidents/${i.id}`,
      icon: <Siren size={15} />, text: norm(`${i.rules.map((r) => r.title).join(" ")} ${i.id}`),
    })),
  ], [summary.data, slo.data, inc.data]);

  const results = useMemo(() => {
    const words = norm(q).trim().split(" ").filter(Boolean);
    if (!words.length) return [...PAGES, ...all.filter((x) => x.group === "Son olaylar").slice(0, 5)];
    return all.filter((x) => words.every((w) => norm(x.label + " " + x.text).includes(w))).slice(0, 40);
  }, [q, all]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  const go = (it: Item) => { onClose(); nav(it.to); };
  const loading = summary.isLoading || slo.isLoading || inc.isLoading;

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div role="dialog" aria-label="Hızlı arama" className="flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-edge bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-edge px-4">
          <Search size={17} className="text-ink-3" />
          <input
            ref={input}
            id="palette-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter" && results[sel]) { e.preventDefault(); go(results[sel]); }
              else if (e.key === "Escape") onClose();
            }}
            placeholder="Kural, servis ya da olay ara…"
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded border border-edge px-1.5 font-mono text-[11px] text-ink-3">esc</kbd>
        </div>
        <ul ref={listRef} className="max-h-[55vh] overflow-y-auto py-1.5">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-ink-3">{loading ? "Veriler yükleniyor…" : "Sonuç yok."}</li>
          )}
          {results.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.group + it.to}>
                {head && <div className="px-4 pt-2.5 pb-1 text-[11px] font-semibold tracking-wider text-ink-3 uppercase">{head}</div>}
                <button
                  type="button"
                  data-i={i}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => go(it)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${i === sel ? "bg-accent-soft text-ink" : "text-ink-2"}`}
                >
                  <span className={i === sel ? "text-accent" : "text-ink-3"}>{it.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="shrink-0 text-[12px] text-ink-3">{it.hint}</span>}
                  {i === sel && <CornerDownLeft size={13} className="shrink-0 text-ink-3" />}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-4 border-t border-edge px-4 py-2 text-[11.5px] text-ink-3">
          <span><kbd className="font-mono">↑ ↓</kbd> gez</span><span><kbd className="font-mono">enter</kbd> aç</span><span><kbd className="font-mono">esc</kbd> kapat</span>
        </div>
      </div>
    </div>
  );
}
