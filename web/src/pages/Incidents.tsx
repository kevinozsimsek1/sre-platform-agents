import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Incident } from "../lib/types";
import { fmtDateTime, fmtMin } from "../lib/format";
import { Empty, ErrorBox, Freshness, Loading, PageHeader, Panel, Pill, Severity, Stat, td, tdn, th, thr } from "../components/ui";

type Resp = { fetched_at: number; gap_min: number; items: Incident[] };

export default function Incidents() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery<Resp>({ queryKey: ["incidents"], queryFn: () => api("/incidents") });
  const [sev, setSev] = useState("");
  const [when, setWhen] = useState("");
  const [hideNoise, setHideNoise] = useState(false);
  const [days, setDays] = useState(7);

  const items = useMemo(() => {
    if (!q.data) return [];
    const since = Date.now() - days * 86_400_000;
    return q.data.items.filter((i) =>
      i.start >= since && (!sev || i.severity === sev) &&
      (!when || (when === "off" ? i.offhours : when === "night" ? i.night : !i.offhours)) &&
      (!hideNoise || !i.preventable));
  }, [q.data, sev, when, hideNoise, days]);

  if (q.isLoading) return <Loading label="Olaylar hesaplanıyor" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const ongoing = d.items.filter((i) => i.ongoing);

  return (
    <>
      <PageHeader eyebrow="Alert analizleri" title="Olaylar ve analiz"
        actions={<Freshness at={d.fetched_at} busy={q.isFetching} onRefresh={() => qc.fetchQuery({ queryKey: ["incidents"], queryFn: () => api("/incidents?refresh=true") })} />}>
        <p className="max-w-[76ch] text-[15px] text-ink-2">
          Birbirine {d.gap_min} dakikadan yakın tetiklenen alert'ler tek olay olarak gruplanır; nöbetçi 10 alert değil, 1 olay yaşar.
          Bir olaya tıklayınca zaman çizelgesi, ilgili kurallar, nereden bakılacağı ve agent analizi açılır.
        </p>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={ongoing.length} label="şu an açık olay" tone={ongoing.length ? "crit" : "good"} />
        <Stat value={items.length} label={`olay (son ${days} gün, filtreli)`} />
        <Stat value={items.filter((i) => i.offhours).length} label="mesai dışında başlayan" />
        <Stat value={items.filter((i) => i.preventable).length} label="sadece bilinen sorunlu kurallardan gelen" hint="Kurallar düzeltilirse büyük ihtimalle hiç oluşmazdı" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {[1, 7, 30].map((n) => (
          <button key={n} type="button" onClick={() => setDays(n)} className={`rounded-md border px-2.5 py-1 text-[13px] ${days === n ? "border-accent bg-accent-soft text-accent" : "border-edge text-ink-2"}`}>
            Son {n === 1 ? "24 saat" : `${n} gün`}
          </button>
        ))}
        <select id="inc-sev" value={sev} onChange={(e) => setSev(e.target.value)} className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[13px]">
          <option value="">Tüm seviyeler</option><option value="critical">critical</option><option value="warning">warning</option>
        </select>
        <select id="inc-when" value={when} onChange={(e) => setWhen(e.target.value)} className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[13px]">
          <option value="">Her zaman</option><option value="work">Mesai içi</option><option value="off">Mesai dışı</option><option value="night">Gece (00–07)</option>
        </select>
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <input id="inc-noise" type="checkbox" checked={hideNoise} onChange={(e) => setHideNoise(e.target.checked)} /> Bilinen gürültüyü gizle
        </label>
      </div>

      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-[13.5px]">
          <thead><tr><th className={th}>Başlangıç</th><th className={thr}>Süre</th><th className={th}>Seviye</th><th className={th}>Kurallar</th><th className={thr}>Alert</th><th className={th}>Not</th></tr></thead>
          <tbody className="divide-y divide-edge-soft">
            {items.map((i) => (
              <tr key={i.id} className="cursor-pointer hover:bg-edge-soft/50" onClick={() => nav(`/incidents/${i.id}`)}>
                <td className={td + " whitespace-nowrap"}><Link to={`/incidents/${i.id}`} className="font-medium hover:text-accent" onClick={(e) => e.stopPropagation()}>{fmtDateTime(i.start)}</Link></td>
                <td className={tdn}>{i.ongoing ? <Pill tone="crit">açık · {fmtMin(i.minutes)}</Pill> : fmtMin(i.minutes)}</td>
                <td className={td}><Severity value={i.severity} /></td>
                <td className={td}>
                  <div className="flex flex-col gap-0.5">
                    {i.rules.slice(0, 3).map((r) => <span key={r.key} className="truncate">{r.title}</span>)}
                    {i.rules.length > 3 && <span className="text-[12px] text-ink-3">+{i.rules.length - 3} kural daha</span>}
                  </div>
                </td>
                <td className={tdn}>{i.episodes}</td>
                <td className={td}>
                  <div className="flex flex-wrap gap-1">
                    {i.night ? <Pill tone="warn">gece</Pill> : i.offhours ? <Pill tone="mute">mesai dışı</Pill> : null}
                    {i.after_related_change ? <Pill tone="crit">ilgili deploy sonrası</Pill> : i.after_change ? <Pill tone="warn">değişiklik sonrası</Pill> : null}
                    {i.preventable && <Pill tone="mute">bilinen gürültü</Pill>}
                    {!!i.analyses && <Pill tone="accent">{i.analyses} analiz</Pill>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <div className="p-4"><Empty>Bu filtrelerle olay yok.</Empty></div>}
      </Panel>
    </>
  );
}
