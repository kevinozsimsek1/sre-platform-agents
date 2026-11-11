import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime, fmtNum } from "../lib/format";
import BarChart from "../components/BarChart";
import { ErrorBox, Freshness, Loading, PageHeader, Panel, Pill, Section, Stat, td, tdn, th, thr } from "../components/ui";

type Resp = {
  toil: {
    fetched_at: number;
    totals: { incidents: number; critical: number; offhours: number; night: number; preventable: number; shifts: number; shifts_over: number; max_shift: number; per_day: number };
    weeks: { week: string; incidents: number; critical: number; offhours: number; night: number; preventable: number; minutes: number }[];
    heat: number[][];
    worst_shifts: { day: string; shift: string; incidents: number }[];
    sources: { key: string; title: string; incidents: number }[];
  };
  gpu: {
    available: boolean; reason?: string; hours?: number; cost_usd?: number; running?: boolean; failed_launches?: number;
    sessions?: { nodegroup: string; instance_type: string; start: number; end: number | null; hours: number; cost_usd: number; running: boolean }[];
    failures?: { nodegroup: string; instance_type: string; t: number; reason: string }[];
    nodegroups?: { nodegroup: string; instance_type: string; price_usd_h: number | null; desired: number }[];
  };
  analyses: number;
};

const DAYS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];

function Heatmap({ heat }: { heat: number[][] }) {
  const max = Math.max(1, ...heat.flat());
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[560px] grid-cols-[34px_repeat(24,1fr)] gap-[3px] text-[10px] text-ink-3">
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="text-center font-mono">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
        {heat.map((row, d) => (
          <Fragment key={d}>
            <span className="self-center">{DAYS[d]}</span>
            {row.map((v, h) => (
              <span
                key={d + "-" + h}
                title={`${DAYS[d]} ${String(h).padStart(2, "0")}:00 · ${v} olay`}
                className="aspect-square rounded-[3px]"
                style={{ background: v ? `color-mix(in oklab, var(--color-crit) ${Math.round(15 + (85 * v) / max)}%, var(--color-panel))` : "var(--color-edge-soft)" }}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export default function Value() {
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ["value"], queryFn: () => api("/value") });
  const [minutes, setMinutes] = useState(15);
  if (q.isLoading) return <Loading label="Nöbet yükü ve GPU geçmişi hesaplanıyor" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const { toil: t, gpu: g, analyses } = q.data!;
  const T = t.totals;
  const hours = (T.incidents * minutes) / 60;
  const avoidHours = (T.preventable * minutes) / 60;

  return (
    <>
      <PageHeader eyebrow="Operasyonel maliyet" title="Maliyet ve değer"
        actions={<Freshness at={t.fetched_at} busy={q.isFetching} onRefresh={() => qc.fetchQuery({ queryKey: ["value"], queryFn: () => api("/value?refresh=true") })} />}>
        <p className="max-w-[80ch] text-[15px] text-ink-2">
          Altyapı faturası değil, operasyonun maliyeti: alert'lerin nöbetçiden aldığı zaman ve uyku, ve bu portalı çalıştıran GPU'nun gerçek maliyeti.
          Ölçüler Google SRE'nin nöbet ve toil ilkelerine göre hesaplanır.
        </p>
      </PageHeader>

      <Section title="Nöbet yükü (son 30 gün)">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat value={T.per_day.toLocaleString("tr-TR")} label="olay / gün" hint={`${fmtNum(T.incidents)} olay, ${fmtNum(T.critical)}'i critical`} />
          <Stat value={`${T.shifts_over} / ${T.shifts}`} label="vardiyada 2'den fazla olay" tone={T.shifts_over > T.shifts * 0.25 ? "crit" : undefined} hint="Google SRE: 12 saatlik vardiyada en fazla 2 olay sürdürülebilir" />
          <Stat value={fmtNum(T.offhours)} label="mesai dışında başlayan olay" hint={`${fmtNum(T.night)}'i gece 00–07 arası`} tone={T.night > 5 ? "warn" : undefined} />
          <Stat value={fmtNum(T.preventable)} label="sadece bilinen sorunlu kurallardan gelen olay" tone="good" hint={<Link to="/alerts" className="text-accent">Bulguları gör</Link>} />
        </div>

        <Panel className="flex flex-col gap-5 p-5">
          <div className="flex flex-col gap-1">
            <h3 className="text-[16px] font-semibold">Alert'ler ekibin ne kadar zamanını aldı?</h3>
            <p className="text-[13.5px] text-ink-2">
              Her olayda nöbetçi bildirimi görür, Grafana'yı açar ve bunun gerçek bir sorun mu yoksa gürültü mü olduğuna karar verir.
              Bunun ortalama ne kadar sürdüğünü seçin; hesap ona göre değişir.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Olay başına süre">
            <span className="mr-1 text-[13px] text-ink-2">Olay başına:</span>
            {[5, 10, 15, 30, 60].map((m) => (
              <button key={m} type="button" role="radio" aria-checked={minutes === m} onClick={() => setMinutes(m)}
                className={`rounded-md border px-3 py-1 text-[13px] tabular-nums ${minutes === m ? "border-accent bg-accent-soft font-medium text-accent" : "border-edge text-ink-2 hover:text-ink"}`}>
                {m} dk
              </button>
            ))}
          </div>

          <div className="grid items-center gap-3 rounded-lg bg-canvas p-4 sm:grid-cols-[1fr_auto_1fr_auto_1.3fr]">
            <div className="flex flex-col">
              <span className="text-[26px] font-semibold tabular-nums">{fmtNum(T.incidents)}</span>
              <span className="text-[12.5px] text-ink-2">olay (30 gün)</span>
            </div>
            <span className="text-xl text-ink-3" aria-hidden>×</span>
            <div className="flex flex-col">
              <span className="text-[26px] font-semibold tabular-nums">{minutes} dk</span>
              <span className="text-[12.5px] text-ink-2">olay başına</span>
            </div>
            <span className="text-xl text-ink-3" aria-hidden>=</span>
            <div className="flex flex-col">
              <span className="text-[26px] font-semibold tabular-nums text-accent">≈ {fmtNum(hours)} saat</span>
              <span className="text-[12.5px] text-ink-2">yaklaşık {(hours / 8).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} iş günü (8 saatlik)</span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-edge-soft">
              <span className="h-full bg-good" style={{ width: `${hours ? (avoidHours / hours) * 100 : 0}%` }} />
              <span className="h-full bg-ink-3/50" style={{ width: `${hours ? ((hours - avoidHours) / hours) * 100 : 0}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13.5px]">
              <span className="flex items-center gap-2"><span className="size-2.5 rounded-sm bg-good" />
                <span><b className="font-semibold">{fmtNum(avoidHours)} saat</b> <span className="text-ink-2">bilinen sorunlu kurallardan ({fmtNum(T.preventable)} olay). Kurallar düzeltilirse bu zaman geri kazanılır.</span></span>
              </span>
              <span className="flex items-center gap-2"><span className="size-2.5 rounded-sm bg-ink-3/50" />
                <span><b className="font-semibold">{fmtNum(Math.round(hours) - Math.round(avoidHours))} saat</b> <span className="text-ink-2">diğer olaylar ({fmtNum(T.incidents - T.preventable)} olay)</span></span>
              </span>
            </div>
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel className="flex flex-col gap-2 p-4">
            <h3 className="font-semibold">Haftalık olay</h3>
            <BarChart data={t.weeks.map((w) => ({ label: fmtDate(w.week), value: w.incidents }))} color="var(--color-accent)" unit="olay" height={180} ariaLabel="Haftalık olay" />
          </Panel>
          <Panel className="flex flex-col gap-2 p-4">
            <h3 className="font-semibold">Olaylar hangi gün ve saatte başlıyor</h3>
            <Heatmap heat={t.heat} />
          </Panel>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead><tr><th className={th}>Nöbetçiyi en çok uğraştıran kural</th><th className={thr}>Olay</th></tr></thead>
              <tbody className="divide-y divide-edge-soft">
                {t.sources.map((s) => (
                  <tr key={s.key}><td className={td}><Link to={`/alerts/${s.key.replace(":", "/")}`} className="hover:text-accent">{s.title}</Link></td><td className={tdn}>{s.incidents}</td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead><tr><th className={th}>En yoğun vardiyalar</th><th className={thr}>Olay</th></tr></thead>
              <tbody className="divide-y divide-edge-soft">
                {t.worst_shifts.map((s) => (
                  <tr key={s.day + s.shift}><td className={td}>{fmtDate(s.day)} · {s.shift} vardiyası</td><td className={tdn}><span className={s.incidents > 5 ? "text-crit" : "text-warn"}>{s.incidents}</span></td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </Section>

      <Section title="Agent altyapısının maliyeti (GPU)">
        {!g.available ? (
          <Panel className="p-4 text-[14px] text-ink-2">GPU geçmişi okunamadı: {g.reason}. Pod'a AWS okuma yetkisi (IRSA) verildiğinde burada görünür.</Panel>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat value={`${(g.hours ?? 0).toLocaleString("tr-TR")} sa`} label="GPU açık kaldı (30 gün)" hint={g.running ? <Pill tone="good">şu an açık</Pill> : <Pill tone="mute">şu an kapalı</Pill>} />
              <Stat value={`$${(g.cost_usd ?? 0).toLocaleString("tr-TR")}`} label="GPU maliyeti (on-demand fiyatla)" />
              <Stat value={fmtNum(analyses)} label="agent analizi yapıldı" hint={analyses ? `analiz başına ~$${((g.cost_usd ?? 0) / analyses).toFixed(2)}` : "henüz yok"} />
              <Stat value={fmtNum(g.failed_launches)} label="başarısız GPU açma denemesi" tone={(g.failed_launches ?? 0) > 20 ? "warn" : undefined} hint="AWS'de o an kapasite yok" />
            </div>
            <Panel className="flex flex-col gap-2 p-4 text-[14px]">
              <p>
                Karşılaştırma: aynı dönemde nöbetçinin alert'lere harcadığı tahmini <b className="font-semibold">{fmtNum(hours)} saate</b> karşı GPU <b className="font-semibold">{(g.hours ?? 0).toLocaleString("tr-TR")} saat</b> açık kaldı
                ve <b className="font-semibold">${(g.cost_usd ?? 0).toLocaleString("tr-TR")}</b> tuttu. Agent analizleri olay başına birkaç dakika kazandırıyorsa GPU kendini öder;
                bunu "analiz yapıldı" sayısı arttıkça bu sayfa gösterecek.
              </p>
              {(g.failed_launches ?? 0) > 20 && (
                <p className="text-ink-2">
                  GPU açma denemelerinin çoğu kapasite yüzünden başarısız. Birden fazla instance tipine izin veren bir node group (ör. g6.xlarge + g5.xlarge) ya da farklı bir zone bu bekleme süresini azaltır.
                </p>
              )}
            </Panel>
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[13.5px]">
                <thead><tr><th className={th}>Açılış</th><th className={th}>Kapanış</th><th className={th}>Node group</th><th className={thr}>Saat</th><th className={thr}>Maliyet</th></tr></thead>
                <tbody className="divide-y divide-edge-soft">
                  {(g.sessions ?? []).map((s) => (
                    <tr key={s.start}>
                      <td className={td}>{fmtDateTime(s.start)}</td>
                      <td className={td}>{s.running ? <Pill tone="good">açık</Pill> : fmtDateTime(s.end)}</td>
                      <td className={td}>{s.nodegroup} <span className="text-ink-3">· {s.instance_type}</span></td>
                      <td className={tdn}>{s.hours.toLocaleString("tr-TR")}</td>
                      <td className={tdn}>${s.cost_usd.toLocaleString("tr-TR")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </>
        )}
      </Section>
    </>
  );
}
