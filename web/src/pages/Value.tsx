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
    totals: {
      incidents: number; critical: number; offhours: number; night: number; preventable: number; shifts: number; shifts_over: number; max_shift: number; per_day: number;
      by_severity: Record<"critical" | "warning" | "none", { incidents: number; preventable: number }>;
      open_hours: number; open_hours_offhours: number;
    };
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

type Sev = "critical" | "warning" | "none";
const SEVS: Sev[] = ["critical", "warning", "none"];
const SEV_META: Record<Sev, { label: string; hint: string }> = {
  critical: { label: "Critical olay", hint: "Nöbetçi işi bırakıp bakar, çoğu zaman başka birini de çağırır." },
  warning: { label: "Warning olay", hint: "Bildirime bakılır, Grafana açılır, gerçek mi gürültü mü karar verilir." },
  none: { label: "Seviyesiz olay", hint: "Kuralda severity etiketi yok." },
};
const EFFORT_KEY = "sre-portal:effort";
const DEFAULT_EFFORT: Record<Sev, number> = { critical: 30, warning: 10, none: 10 };
function loadEffort(): Record<Sev, number> {
  try { return { ...DEFAULT_EFFORT, ...JSON.parse(localStorage.getItem(EFFORT_KEY) || "{}") }; } catch { return DEFAULT_EFFORT; }
}

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
  const [effort, setEffort] = useState<Record<Sev, number>>(loadEffort);
  if (q.isLoading) return <Loading label="Nöbet yükü ve GPU geçmişi hesaplanıyor" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const { toil: t, gpu: g, analyses } = q.data!;
  const T = t.totals;
  const rows = SEVS.map((k) => ({ ...SEV_META[k], key: k, ...T.by_severity[k], min: effort[k] }))
    .filter((r) => r.incidents > 0)
    .map((r) => ({ ...r, hours: (r.incidents * r.min) / 60, avoid: (r.preventable * r.min) / 60 }));
  const hours = rows.reduce((a, r) => a + r.hours, 0);
  const avoidHours = rows.reduce((a, r) => a + r.avoid, 0);
  const setMin = (k: Sev, v: number) => {
    const next = { ...effort, [k]: Math.max(0, Math.min(480, Math.round(v) || 0)) };
    setEffort(next);
    try { localStorage.setItem(EFFORT_KEY, JSON.stringify(next)); } catch { /* özel pencere */ }
  };

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
              İki ayrı şey: olayların gerçekten ne kadar açık kaldığı (ölçülen) ve ekibin bunlara harcadığı emek (tahmin).
              Tahmini, olayın önem derecesine göre ayrı ayrı girebilirsiniz; değerler bu tarayıcıda saklanır.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-0.5 rounded-lg bg-canvas p-4">
              <span className="text-[12px] font-semibold tracking-wider text-ink-3 uppercase">Ölçülen</span>
              <span className="text-[24px] font-semibold tabular-nums">{T.open_hours.toLocaleString("tr-TR")} saat</span>
              <span className="text-[13px] text-ink-2">olayların toplam açık kalma süresi, {T.open_hours_offhours.toLocaleString("tr-TR")} saati mesai dışında</span>
            </div>
            <div className="flex flex-col gap-0.5 rounded-lg bg-canvas p-4">
              <span className="text-[12px] font-semibold tracking-wider text-ink-3 uppercase">Tahmini emek</span>
              <span className="text-[24px] font-semibold tabular-nums text-accent">≈ {fmtNum(hours)} saat</span>
              <span className="text-[13px] text-ink-2">yaklaşık {(hours / 8).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} iş günü (8 saatlik), aşağıdaki tabloya göre</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13.5px]">
              <thead><tr>
                <th className={th}>Olay türü</th><th className={thr}>Olay sayısı</th><th className={thr}>Olay başına emek</th><th className={thr}>Toplam</th><th className={thr}>Bilinen gürültüden</th>
              </tr></thead>
              <tbody className="divide-y divide-edge-soft">
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className={td}><div className="font-medium">{r.label}</div><div className="text-[12px] text-ink-3">{r.hint}</div></td>
                    <td className={tdn}>{fmtNum(r.incidents)}</td>
                    <td className={td + " text-right"}>
                      <label className="inline-flex items-center gap-1.5">
                        <span className="sr-only">{r.label} için dakika</span>
                        <input id={`effort-${r.key}`} type="number" min={0} max={480} step={5} value={r.min}
                          onChange={(e) => setMin(r.key, Number(e.target.value))}
                          className="w-20 rounded-md border border-edge bg-canvas px-2 py-1 text-right font-mono text-[13px] tabular-nums" />
                        <span className="text-ink-2">dk</span>
                      </label>
                    </td>
                    <td className={tdn}>{fmtNum(r.hours)} sa</td>
                    <td className={tdn}><span className="text-good">{fmtNum(r.avoid)} sa</span> <span className="text-ink-3">({fmtNum(r.preventable)} olay)</span></td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className={td}>Toplam</td><td className={tdn}>{fmtNum(T.incidents)}</td><td className={td} />
                  <td className={tdn}>{fmtNum(hours)} sa</td><td className={tdn}><span className="text-good">{fmtNum(avoidHours)} sa</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-[13.5px]">
            Bilinen sorunlu kurallar düzeltilirse ayda yaklaşık <b className="font-semibold text-good">{fmtNum(avoidHours)} saat</b> geri kazanılır.
          </p>
          <p className="border-t border-edge-soft pt-3 text-[12.5px] text-ink-3">
            Büyük ekipler bu emeği tahmin etmez, ölçer: nöbet aracı her olay için "kim üstlendi, ne zaman çözdü" bilgisini tutar.
            Alert'ler şu an sadece Google Chat'e gittiği için bu bilgi yok; bir nöbet aracı bağlanırsa bu tablo gerçek ölçümle dolar.
          </p>
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
