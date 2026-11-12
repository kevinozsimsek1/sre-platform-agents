import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, RotateCcw, Wand2 } from "lucide-react";
import { api, del, put } from "../lib/api";
import type { SloService } from "../lib/types";
import { fmtNum, fmtPct } from "../lib/format";
import { STATUS, SourcePill, TargetText } from "./Slo";
import { ErrorBox, Loading, Panel, Pill, td, tdn, th, thr } from "../components/ui";

type Def = { availability: number; latency_ms: number; latency_target: number };
type Resp = { default: Def; defined: Record<string, unknown>; window_days: number; min_requests: number; services: SloService[] };
type Form = { latency_ms: number; latency_target: number; availability: number; owner: string; note: string };

const BUCKETS = [25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];
const input = "rounded-md border border-edge bg-canvas px-2 py-1 text-[13px]";

function Fields({ f, set }: { f: Form; set: (f: Form) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="flex flex-col gap-1 text-[12.5px] text-ink-2">Hızlı yanıt sınırı
        <select className={input} value={f.latency_ms} onChange={(e) => set({ ...f, latency_ms: +e.target.value })}>
          {BUCKETS.map((b) => <option key={b} value={b}>{fmtNum(b)} ms</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] text-ink-2">Bu sınırın altında kalması gereken istek (%)
        <input className={input} type="number" min={50} max={100} step={0.1} value={f.latency_target} onChange={(e) => set({ ...f, latency_target: +e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] text-ink-2">Hatasız yanıt (%)
        <input className={input} type="number" min={50} max={100} step={0.01} value={f.availability} onChange={(e) => set({ ...f, availability: +e.target.value })} />
      </label>
    </div>
  );
}

function Editor({ s, onDone }: { s: SloService; onDone: () => void }) {
  const qc = useQueryClient();
  const t = s.target;
  const [f, setF] = useState<Form>({
    latency_ms: t.latency_ms, latency_target: +(t.latency_target * 100).toFixed(2), availability: +(t.availability * 100).toFixed(3),
    owner: t.owner ?? "", note: t.note ?? "",
  });
  const refresh = () => { ["admin-targets", "slo", "overview"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); onDone(); };
  const save = useMutation({ mutationFn: () => put(`/admin/slo-targets/services/${encodeURIComponent(s.service)}`, { ...f, owner: f.owner || null, note: f.note || null }), onSuccess: refresh });
  const reset = useMutation({ mutationFn: () => del(`/admin/slo-targets/services/${encodeURIComponent(s.service)}`), onSuccess: refresh });
  const g = s.suggested;
  return (
    <div className="flex flex-col gap-3 rounded-md bg-canvas p-4">
      <Fields f={f} set={setF} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12.5px] text-ink-2">Sahibi (ekip)
          <input className={input} value={f.owner} maxLength={200} onChange={(e) => setF({ ...f, owner: e.target.value })} placeholder="ör. Ödeme ekibi" />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] text-ink-2">Gerekçe
          <input className={input} value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="ör. Cihaz ödemeleri dış servise bağlı, doğal olarak yavaş" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60">Kaydet</button>
        {g?.latency_ms != null && (
          <button type="button" onClick={() => setF({ ...f, latency_ms: g.latency_ms!, latency_target: +((g.latency_target ?? 0.99) * 100).toFixed(1), availability: +((g.availability ?? t.availability) * 100).toFixed(2) })}
            className="inline-flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink-2 hover:text-ink">
            <Wand2 size={13} /> Öneriyi doldur
          </button>
        )}
        {t.source === "tanımlı" && (
          <button type="button" onClick={() => reset.mutate()} disabled={reset.isPending} className="inline-flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink-2 hover:text-ink">
            <RotateCcw size={13} /> Varsayılana dön
          </button>
        )}
        <button type="button" onClick={onDone} className="px-2 py-1.5 text-[13px] text-ink-3 hover:text-ink">Vazgeç</button>
        {(save.error || reset.error) && <span className="text-[13px] text-crit">{((save.error || reset.error) as Error).message}</span>}
      </div>
    </div>
  );
}

function DefaultEditor({ d }: { d: Def }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState<Form>({ latency_ms: d.latency_ms, latency_target: +(d.latency_target * 100).toFixed(2), availability: +(d.availability * 100).toFixed(3), owner: "", note: "" });
  const save = useMutation({
    mutationFn: () => put("/admin/slo-targets/default", { latency_ms: f.latency_ms, latency_target: f.latency_target, availability: f.availability }),
    onSuccess: () => { ["admin-targets", "slo", "overview"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setEdit(false); },
  });
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Varsayılan hedef</h3>
          <p className="text-[13px] text-ink-2">Özel hedefi olmayan bütün servisler bununla ölçülür: <b className="font-medium text-ink"><TargetText t={d} /></b></p>
        </div>
        {!edit && <button type="button" onClick={() => setEdit(true)} className="inline-flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink-2 hover:text-ink"><Pencil size={13} /> Değiştir</button>}
      </div>
      {edit && (
        <div className="flex flex-col gap-3 rounded-md bg-canvas p-4">
          <Fields f={f} set={setF} />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60">Kaydet</button>
            <button type="button" onClick={() => setEdit(false)} className="px-2 py-1.5 text-[13px] text-ink-3 hover:text-ink">Vazgeç</button>
            {save.error && <span className="text-[13px] text-crit">{(save.error as Error).message}</span>}
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Yönetim: servis hedeflerini belirleme. Öneriler sadece burada görünür. */
export default function AdminTargets() {
  const q = useQuery<Resp>({ queryKey: ["admin-targets"], queryFn: () => api("/admin/slo-targets") });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Loading inline />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const services = d.services.filter((s) => s.status !== "low_traffic").concat(d.services.filter((s) => s.status === "low_traffic"));

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-[80ch] text-[14px] text-ink-2">
        Servis hedefleri burada belirlenir; herkese açık sayfada sadece hedef ve gerçekleşen görünür. Öneri, son {d.window_days} günün gerçek performansına göre
        servisin tutturabileceği en iddialı standart seviyedir. Hedefi koymadan önce servisin sahibi ekiple konuşun. Her değişiklik denetim kaydına düşer.
      </p>
      <DefaultEditor d={d.default} />
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-[13.5px]">
          <thead><tr>
            <th className={th}>Servis</th><th className={th}>Durum</th><th className={th}>Mevcut hedef</th>
            <th className={thr}>Gerçekleşen</th><th className={th}>Öneri</th><th className={th} />
          </tr></thead>
          <tbody className="divide-y divide-edge-soft">
            {services.map((s) => {
              const m = s.measured;
              const g = s.suggested;
              const differs = g?.latency_ms != null && (g.latency_ms !== s.target.latency_ms || g.availability !== s.target.availability);
              return (
                <Fragment key={s.service}>
                  <tr className={open === s.service ? "bg-edge-soft/40" : ""}>
                    <td className={td}><div className="font-medium">{s.service}</div><div className="text-[12px] text-ink-3">{fmtNum(m?.requests)} istek</div></td>
                    <td className={td}><Pill tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Pill></td>
                    <td className={td + " text-[12.5px]"}>
                      <div>%{(s.target.latency_target * 100).toFixed(0)} · {fmtNum(s.target.latency_ms)} ms · {fmtPct(s.target.availability, 2)} hatasız</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5"><SourcePill t={s.target} />{s.target.note && <span className="text-ink-3">{s.target.note}</span>}</div>
                    </td>
                    <td className={tdn + " text-[12.5px]"}>
                      {m ? <><div>{fmtPct(m.latency, 1)} hızlı</div><div className="text-ink-3">{fmtPct(m.availability, 2)} hatasız</div></> : "—"}
                      {s.p95_ms != null && <div className="text-ink-3">p95 {fmtNum(s.p95_ms)} · p99 {fmtNum(s.p99_ms)} ms</div>}
                    </td>
                    <td className={td + " text-[12.5px]"}>
                      {g?.latency_ms != null ? (
                        <span className={differs ? "text-ink" : "text-ink-3"}>%{((g.latency_target ?? 0.99) * 100).toFixed(0)} · {fmtNum(g.latency_ms)} ms · {fmtPct(g.availability ?? 0, 2)}{!differs && " (aynı)"}</span>
                      ) : <span className="text-ink-3">yeterli veri yok</span>}
                    </td>
                    <td className={td + " text-right"}>
                      <button type="button" onClick={() => setOpen(open === s.service ? null : s.service)} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent">
                        <Pencil size={13} /> Düzenle
                      </button>
                    </td>
                  </tr>
                  {open === s.service && <tr><td colSpan={6} className="px-3 pb-3"><Editor s={s} onDone={() => setOpen(null)} /></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
