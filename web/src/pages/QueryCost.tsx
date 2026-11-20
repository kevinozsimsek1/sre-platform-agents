import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Lightbulb, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import type { CostDashboard, CostRule, CostWidget, QueryCost as QC } from "../lib/types";
import { fmtDateTime, fmtNum } from "../lib/format";
import BarChart from "../components/BarChart";
import CostReport from "../components/CostReport";
import CostTasks from "../components/CostTasks";
import { Empty, ErrorBox, Freshness, Info, Loading, PageHeader, Panel, Pill, Section, Stat, td, tdn, th, thr } from "../components/ui";

const usd = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const every = (s: number | null) => (s == null ? "kapalı" : s >= 60 ? `${s / 60} dk` : `${s} sn`);
// Fatura dönemleri ay adıyla yazılır: "1 Tem" okunmuyor, "Temmuz 2026" okunuyor.
const AY_UZUN = new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric", timeZone: "UTC" });
const AY_KISA = new Intl.DateTimeFormat("tr-TR", { month: "long", timeZone: "UTC" });
const ay = (iso: string) => AY_UZUN.format(new Date(`${iso.slice(0, 10)}T12:00:00Z`));
const ayKisa = (iso: string) => AY_KISA.format(new Date(`${iso.slice(0, 10)}T12:00:00Z`));

/** Faturadaki miktar birimi kaleme göre değişir: metrik adedi, GB, alarm sayısı. */
function qty(usageType: string, q: number): string {
  if (/Bytes/i.test(usageType)) return `${fmtNum(q)} GB`;
  if (/GMD-Metrics|GMWI|ObservationUsage|Requests/i.test(usageType)) return `${fmtNum(q)} adet`;
  return fmtNum(q);
}

function WidgetRow({ w }: { w: CostWidget }) {
  const [open, setOpen] = useState(false);
  const tips = w.queries.flatMap((q) => q.tips);
  return (
    <>
      <tr>
        <td className={`${td} pl-8`}>
          <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-start gap-1.5 text-left hover:text-accent">
            {open ? <ChevronDown size={13} className="mt-1 shrink-0" /> : <ChevronRight size={13} className="mt-1 shrink-0" />}
            <span>
              <span className="font-medium">{w.title}</span>
              <span className="block text-[12px] text-ink-3">
                {w.type}
                {w.repeat && " · değişkenle çoğaltılıyor"}
                {w.math > 0 && ` · ${w.math} metric math`}
                {w.expands > 0 && ` · ${w.expands} sorgu çoğalıyor`}
              </span>
            </span>
          </button>
        </td>
        <td className={tdn}>{w.metric_queries || "—"}</td>
        <td className={tdn}>{w.logs_queries || "—"}</td>
        <td className={tdn}>{w.real_metrics_month != null ? fmtNum(w.real_metrics_month) : "—"}</td>
        <td className={tdn}>{usd(w.real_cost_month)}</td>
      </tr>
      {open && (
        <tr>
          <td className={`${td} bg-canvas`} colSpan={5}>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold tracking-wider text-ink-3 uppercase">Bu widget ne soruyor</span>
                {w.queries.map((q, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Pill tone={q.kind === "logs" ? "warn" : q.math ? "mute" : "accent"}>
                      {q.kind === "logs" ? "Logs Insights" : q.math ? "metric math" : "metrik"}
                    </Pill>
                    <code className="min-w-0 flex-1 font-mono text-[12px] break-all">{q.text}</code>
                    {q.period_s != null && <span className="font-mono text-[11.5px] text-ink-3">period {q.period_s}s</span>}
                  </div>
                ))}
              </div>
              {tips.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-md bg-accent-soft/60 p-3">
                  <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-accent">
                    <Lightbulb size={13} /> Nasıl düşürülür
                  </span>
                  <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] text-ink-2">
                    {[...new Set(tips)].map((t) => <li key={t}>{t}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DashRow({ d, dup }: { d: CostDashboard; dup: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="bg-edge-soft/30">
        <td className={td}>
          <div className="flex items-start gap-1.5">
            <button type="button" onClick={() => setOpen((v) => !v)} aria-label="Widget'ları göster" className="mt-1 shrink-0 text-ink-3 hover:text-accent">
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <span className="min-w-0">
              <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-semibold hover:text-accent">
                {d.title} <ExternalLink size={12} className="shrink-0 text-ink-3" />
              </a>
              <span className="block text-[12px] text-ink-3">
                org {d.org}{d.folder && ` · ${d.folder}`} · yenileme {d.refresh ?? "kapalı"} · {d.panels} panel
                {d.hidden_panels > 0 && ` (+${d.hidden_panels} kapalı satırda, sayılmadı)`}
              </span>
              {(dup || d.uncertain) && (
                <span className="block text-[12px] text-warn">
                  {dup && "aynı adda birden fazla dashboard var"}
                  {dup && d.uncertain && " · "}
                  {d.expands > 0 && `${d.expands} sorgu birden çok metriğe açılıyor`}
                  {d.repeats > 0 && ` · ${d.repeats} panel çoğaltılıyor`}
                  {d.unknown > 0 && ` · ${d.unknown} sorgunun kaynağı değişken`}
                </span>
              )}
            </span>
          </div>
        </td>
        <td className={tdn}>{d.cloudwatch_metric || "—"}</td>
        <td className={tdn}>{d.cloudwatch_logs || "—"}</td>
        <td className={tdn}>{d.real_metrics_month != null ? fmtNum(d.real_metrics_month) : "—"}</td>
        <td className={tdn}><b>{usd(d.real_cost_month)}</b></td>
      </tr>
      {open && d.widgets.map((w, i) => <WidgetRow key={`${w.title}-${i}`} w={w} />)}
      {open && d.widgets.length === 0 && (
        <tr><td className={`${td} pl-8 text-ink-3`} colSpan={5}>CloudWatch sorgusu olan panel yok.</td></tr>
      )}
    </>
  );
}

/** Sunumda ya da e-postada kullanmak için metin özeti. */
function CopySummary({ d }: { d: QC }) {
  const [ok, setOk] = useState(false);
  const text = () => {
    const b = d.bill, at = d.attribution, L: string[] = [];
    L.push("PROD CLOUDWATCH SORGU MALİYETİ");
    if (b.available) {
      L.push(`Kaynak: AWS Cost Explorer, ${b.service}${b.account ? `, hesap ${b.account}` : ""}`);
      L.push("");
      L.push("Aylık toplam:");
      for (const m of b.months) L.push(`  ${ay(m.start)}${m.partial ? " (sürüyor)" : ""}: ${usd(m.total)}`);
      L.push("");
      L.push(`Metrik sorgusu kalemi (${ay(b.last_full.start)}): ${usd(at.real_cost_month)} / ${fmtNum(at.real_metrics_month)} metrik`);
      L.push(`  alert kurallarının payı: ${usd(at.rule_cost_month)} (${fmtNum(at.rule_metrics_month)} metrik, ölçülen)`);
      L.push(`  dashboard'ların payı:    ${usd(at.dashboard_cost_month)} (${fmtNum(at.dashboard_metrics_month)} metrik)`);
      L.push(`Logs Insights taraması:  ${usd(b.scanned.cost)} / ${fmtNum(b.scanned.quantity)} GB`);
      L.push(`Log alımı:               ${usd(b.ingest.cost)} / ${fmtNum(b.ingest.quantity)} GB`);
    }
    const open = d.tasks.filter((t) => !t.assignee?.done_at);
    const saving = open.reduce((n, t) => n + (t.saving_usd ?? 0), 0);
    L.push("");
    L.push(`İYİLEŞTİRME: ${open.length} açık görev, hesaplanabilen kazanç ${usd(saving)}/ay`);
    for (const t of open.slice(0, 8)) {
      L.push(`  - ${t.title}${t.saving_usd ? ` (${usd(t.saving_usd)}/ay)` : ""}`);
      L.push(`      ${t.fix}`);
    }
    return L.join("\n");
  };
  return (
    <button type="button"
      onClick={() => navigator.clipboard?.writeText(text())
        .then(() => { setOk(true); setTimeout(() => setOk(false), 1800); }).catch(() => {})}
      className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[13px] text-ink-2 hover:text-ink">
      {ok ? <Check size={13} /> : <Copy size={13} />} {ok ? "Kopyalandı" : "Özeti kopyala"}
    </button>
  );
}

export default function QueryCost() {
  const qc = useQueryClient();
  const q = useQuery<QC>({ queryKey: ["query-cost"], queryFn: () => api("/query-cost"), staleTime: 600_000 });
  const [allDash, setAllDash] = useState(false);
  const [allRules, setAllRules] = useState(false);

  const dupTitles = useMemo(() => {
    const n = new Map<string, number>();
    for (const d of q.data?.dashboards ?? []) n.set(d.title, (n.get(d.title) ?? 0) + 1);
    return new Set([...n].filter(([, c]) => c > 1).map(([t]) => t));
  }, [q.data]);

  if (q.isLoading) return <Loading label="Gerçek fatura ve bütün dashboard'lar okunuyor (ilk açılış ~30 sn)" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const { bill, attribution: at, summary: s } = d;
  const cwDash = d.dashboards.filter((x) => x.cloudwatch_metric || x.cloudwatch_logs);
  const shownDash = allDash ? cwDash : cwDash.slice(0, 12);
  const metricRules = d.rules.filter((r) => r.metric_queries > 0);
  const shownRules = allRules ? metricRules : metricRules.slice(0, 12);

  return (
    <>
      <PageHeader eyebrow="Maliyet" title="Sorgu maliyeti"
        actions={
          <>
            <CostReport d={d} />
            <CopySummary d={d} />
            <Freshness at={d.fetched_at} busy={q.isFetching} onRefresh={() => qc.fetchQuery({ queryKey: ["query-cost"], queryFn: () => api("/query-cost?refresh=true") })} />
          </>
        }>
        <p className="max-w-[82ch] text-[15px] text-ink-2">
          Prod'daki Grafana dashboard'ları ve alert kurallarının CloudWatch'a çıkardığı fatura.
          Üstteki rakamlar <b className="font-semibold">AWS'nin kestiği faturadan</b> okunuyor; alttaki kırılım,
          o faturanın hangi dashboard ve hangi widget'tan geldiğini gösteriyor.
        </p>
      </PageHeader>

      <nav aria-label="Sayfa bölümleri" className="flex flex-wrap gap-1.5">
        {([["gorevler", "Yapılacaklar"], ["kazanc", "Kazanç"], ["fatura", "Gerçek fatura"],
           ["yontem", "Nasıl hesaplandı"], ["kirilim", "Dashboard kırılımı"], ["loglar", "Logs Insights"]] as const)
          .filter(([id]) => id !== "kazanc" || d.savings.count > 0)
          .map(([id, label]) => (
          // Portal HashRouter kullandığı için href="#..." router'ı yanlış yere götürür: kaydırma ile git.
          <button key={id} type="button"
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="rounded-full border border-edge px-3 py-1 text-[12.5px] text-ink-2 hover:border-accent hover:text-accent">
            {label}
          </button>
        ))}
      </nav>

      {d.savings.count > 0 && (
        <section id="kazanc" className="flex flex-col gap-3 scroll-mt-4">
          <Section title="Tamamlanan iyileştirmeler" aside={`${d.savings.count} görev kapatıldı`}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Stat value={usd(d.savings.monthly_usd)} label="aylık yinelenen kazanç" tone="good"
                hint={<span className="inline-flex items-center gap-1.5">tamamlanan görevlerden
                  <Info title="Aylık kazanç nasıl hesaplandı">
                    Tamamlanmış her görevin kapatıldığı anda ölçülen aylık kazancının toplamı. Düzeltme yerinde
                    kaldığı sürece bu tutar her ay tekrar eder; bu yüzden tek seferlik değil, yinelenen kazançtır.
                  </Info></span>} />
              <Stat value={usd(d.savings.accrued_usd)} label="bugüne kadar birikmiş kazanç"
                hint={<span className="inline-flex items-center gap-1.5">
                  {d.savings.first_done_at ? `${fmtDateTime(d.savings.first_done_at).slice(0, 10)}'den beri` : "—"}
                  <Info title="Birikmiş kazanç nasıl hesaplandı">
                    Her görevin aylık kazancı, tamamlandığı günden bugüne geçen ay sayısıyla çarpılıp toplanıyor.
                    Yani "bu düzeltmeler yapılmasaydı bugüne kadar fazladan ne ödenmiş olurdu" sorusunun cevabı.
                  </Info></span>} />
              <Stat value={usd(d.savings.open_potential_usd)} label="açık görevlerde bekleyen kazanç"
                hint="henüz yapılmadı" />
            </div>
            {d.savings.regressed.length > 0 && (
              <Panel className="flex items-start gap-3 border-warn/40 p-4 text-[14px]">
                <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warn" />
                <div className="flex flex-col gap-1">
                  <b className="font-semibold">{d.savings.regressed.length} görev tamamlandı işaretli ama bulgu yeniden görünüyor</b>
                  <p className="text-ink-2">
                    Düzeltme geri alınmış ya da başka bir yerde tekrar ortaya çıkmış olabilir:
                    {" "}{d.savings.regressed.map((x) => x.title).join(", ")}
                  </p>
                </div>
              </Panel>
            )}
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-[13.5px]">
                <thead>
                  <tr><th className={th}>Tamamlanan görev</th><th className={th}>Kim</th><th className={th}>Tarih</th>
                    <th className={thr}>Aylık</th><th className={thr}>Bugüne kadar</th></tr>
                </thead>
                <tbody className="divide-y divide-edge-soft">
                  {d.savings.done.map((x) => (
                    <tr key={x.id}>
                      <td className={td}>
                        {x.title}
                        {!x.still_fixed && <span className="block text-[12px] text-warn">bulgu yeniden görünüyor</span>}
                      </td>
                      <td className={td}>{x.to ?? "—"}</td>
                      <td className={td}><span className="text-ink-2">{fmtDateTime(x.done_at)}</span></td>
                      <td className={tdn}>{usd(x.saving_usd)}</td>
                      <td className={tdn}>{usd(x.accrued_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </Section>
        </section>
      )}

      <span id="gorevler" className="scroll-mt-4" aria-hidden />
      {d.tasks.length > 0 && (
        <Section title="Yapılacaklar" aside="Her görev kişiye atanır; tamamlanınca işaretlenir ve denetim kaydına düşer">
          <Panel className="flex items-start gap-2.5 p-3.5 text-[13.5px]">
            <Info title="Buradaki tutarlar ne anlama geliyor">
              Toplam fatura gerçektir (AWS Cost Explorer). Görev başına yazan tutar ise o kalemin
              <b> bu dashboard'a / kurala düşen payı</b>dır — AWS dashboard ya da kural başına fatura kesmez.
              Pay, ölçülen sorgu yüküne oranla hesaplanıyor. Tek istisna "Log hacmi" görevi: oradaki rakam
              doğrudan fatura satırının kendisi. Her rakamın yanındaki ⓘ hangisinin hangisi olduğunu söylüyor.
            </Info>
            <span className="text-ink-2">
              Tutarlar, gerçek faturanın ilgili kaleme düşen <b className="font-semibold">payı</b>dır; kalem başına
              kesilmiş fatura değildir. Her rakamın yanındaki ⓘ nasıl hesaplandığını açıklıyor.
            </span>
          </Panel>
          <CostTasks tasks={d.tasks} team={d.team} />
        </Section>
      )}

      {!bill.available ? (
        <Panel className="flex items-start gap-3 border-warn/40 p-4">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warn" />
          <div className="flex flex-col gap-1 text-[14px]">
            <b className="font-semibold">Gerçek fatura okunamadı, aşağıdaki rakamlar yalnızca sorgu sayımıdır.</b>
            <p className="text-ink-2">{bill.reason}</p>
            <p className="text-ink-2">
              Portala prod hesabında <span className="font-mono text-[12.5px]">ce:GetCostAndUsage</span> okuma yetkisi verilince
              bu bölüm gerçek fatura rakamlarıyla dolar.
            </p>
          </div>
        </Panel>
      ) : (
        <>
          <span id="fatura" className="scroll-mt-4" aria-hidden />
          <Section title="Gerçek fatura" aside={`AWS Cost Explorer · ${bill.service}${bill.account ? ` · hesap ${bill.account}` : ""}`}>
            <Panel className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[14px] text-ink-2">
                  Son tam ay <b className="font-semibold text-ink">{usd(bill.last_full.total)}</b>
                  {bill.months.length > 1 && (() => {
                    const full = bill.months.filter((m) => !m.partial);
                    if (full.length < 2) return null;
                    const first = full[0], last = full[full.length - 1];
                    const pct = first.total ? Math.round(((last.total - first.total) / first.total) * 100) : 0;
                    const dir = pct > 0 ? "arttı" : pct < 0 ? "azaldı" : "değişmedi";
                    return <> · {ay(first.start)}'dan {ay(last.start)}'a{" "}
                      <b className={`font-semibold ${pct > 0 ? "text-crit" : "text-good"}`}>%{Math.abs(pct)} {dir}</b></>;
                  })()}
                </span>
                {bill.current.partial && (
                  <span className="text-[12.5px] text-ink-3">{ay(bill.current.start)} ayı sürüyor: {usd(bill.current.total)}</span>
                )}
              </div>
              <BarChart data={bill.months.map((m) => ({ label: ayKisa(m.start), value: Math.round(m.total * 100) / 100 }))}
                color="var(--color-accent)" unit="$" height={170} ariaLabel="Aylık CloudWatch faturası" />
            </Panel>
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[13.5px]">
                <thead>
                  <tr>
                    <th className={th}>
                      <span className="inline-flex items-center gap-1.5">
                        Fatura kalemi ({ay(bill.last_full.start)})
                        <Info title="Bu tablo nereden geliyor">
                          AWS Cost Explorer'dan <span className="font-mono">GetCostAndUsage</span> çağrısıyla,
                          servis <span className="font-mono">AmazonCloudWatch</span> filtresi ve kullanım tipine göre gruplanarak okunuyor.
                          Tahmin ya da liste fiyatı hesabı değil: kesilmiş faturadaki satırların kendisi.
                          Cost Explorer istek başına $0,01 aldığı ve fatura verisi günde en çok bir iki kez
                          güncellendiği için günde bir yenilenir: ayda ~30 istek, yani $0,30. Sağ üstteki
                          yenile düğmesi beklemeden yeni veri çeker ve o istek de aynı ücrete tabidir.
                        </Info>
                      </span>
                    </th>
                    <th className={thr}>Miktar</th>
                    <th className={thr}>Tutar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-soft">
                  {bill.last_full.items.map((i) => (
                    <tr key={i.usage_type}>
                      <td className={td}>
                        <span className="font-medium">{i.label}</span>
                        <span className="block font-mono text-[11.5px] text-ink-3">{i.usage_type}</span>
                        {i.what && <span className="block text-[12.5px] text-ink-2">{i.what}</span>}
                      </td>
                      <td className={tdn}>{qty(i.usage_type, i.quantity)}</td>
                      <td className={tdn}>{usd(i.cost)}</td>
                    </tr>
                  ))}
                  <tr className="bg-edge-soft/40">
                    <td className={`${td} font-semibold`}>Toplam</td>
                    <td className={tdn}></td>
                    <td className={`${tdn} font-semibold`}>{usd(bill.last_full.total)}</td>
                  </tr>
                </tbody>
              </table>
            </Panel>
          </Section>

          <span id="yontem" className="scroll-mt-4" aria-hidden />
          <Section title="Fatura nasıl dağıtıldı" aside="Sunumda anlatılacak yöntem">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat value={usd(at.real_cost_month)} label="metrik sorgusu kalemi (gerçek)"
                hint={<span className="inline-flex items-center gap-1.5">{fmtNum(at.real_metrics_month)} metrik
                  <Info title="Gerçek metrik sorgusu maliyeti">
                    Faturadaki <span className="font-mono">CW:GMD-Metrics</span> satırı. AWS, dashboard ve alert'lerin
                    çektiği <b>her metrik</b> için ücret alır. {ay(at.period ?? bill.last_full.start)} ayında{" "}
                    {fmtNum(at.real_metrics_month)} metrik çekilmiş ve {usd(at.real_cost_month)} tutmuş.
                    Metrik başına {(at.usd_per_metric * 1000).toFixed(4)} dolar / 1000 metrik ediyor.
                  </Info></span>} />
              <Stat value={usd(at.rule_cost_month)} label="alert kurallarının payı" tone="warn"
                hint={<span className="inline-flex items-center gap-1.5">
                  {at.rule_share != null ? `yükün %${Math.round(at.rule_share * 100)}'i` : "—"}
                  <Info title="Kuralların payı nasıl bulundu">
                    Her kuralın kaç metrik istediği CloudWatch'a sorularak ölçülüyor (ListMetrics), ayda kaç kez
                    değerlendirildiğiyle çarpılıyor. Kurallar 7/24 çalışır, yükleri kimsenin ekrana bakmasına bağlı değildir.
                    Fatura, kurallar ile dashboard'lar arasında bu ölçülen yüke oranla paylaştırılıyor.
                  </Info></span>} />
              <Stat value={usd(at.dashboard_cost_month)} label="dashboard'ların payı"
                hint={<span className="inline-flex items-center gap-1.5">
                  {at.dashboard_metrics_month != null ? `${fmtNum(at.dashboard_metrics_month)} metrik` : "—"}
                  <Info title="Dashboard payı nasıl bulundu">
                    Her panelin kaç metrik istediği ölçülüp yenileme sıklığıyla çarpılıyor, sonra fatura bu yüke
                    oranla paylaştırılıyor. Bir dashboard'ın payı da panellerine, panelin ölçülen metrik sayısı oranında dağıtılıyor.
                    Yenilemesi kapalı dashboard'ların ağırlığı sıfırdır; açıldıklarında sorgu atarlar, o kısım burada görünmez.
                  </Info></span>} />
              <Stat value={usd(bill.scanned.cost)} label="Logs Insights taraması (gerçek)"
                tone={bill.scanned.cost > 50 ? "crit" : undefined}
                hint={<span className="inline-flex items-center gap-1.5">{fmtNum(bill.scanned.quantity)} GB tarandı
                  <Info title="Logs Insights taraması">
                    Faturadaki <span className="font-mono">DataScanned-Bytes</span> satırı: log sorgularının taradığı bayt.
                    Aşağıdaki "Logs Insights kuralları" bölümü bu kalemi açıklıyor; bir kuralın penceresi
                    değerlendirme aralığından kaç kat uzunsa, aynı loglar o kadar kez yeniden taranır.
                  </Info></span>} />
            </div>
            <Panel className="flex flex-col gap-2 p-4 text-[14px]">
              <b className="font-semibold">Yöntem, üç adım</b>
              <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-ink-2">
                <li><b className="font-medium text-ink">Toplam faturadan okunur.</b> AWS Cost Explorer, <span className="font-mono text-[12.5px]">CW:GMD-Metrics</span> satırı. Tahmin yok.</li>
                <li><b className="font-medium text-ink">Her sorgunun kaç metrik istediği ölçülür.</b> CloudWatch ListMetrics ile sayılır, değerlendirme ya da yenileme sıklığıyla çarpılır.</li>
                <li><b className="font-medium text-ink">Fatura bu yüke oranla paylaştırılır.</b> Tutarlar "pay"dır; sıralama ölçüme dayanır.</li>
              </ol>
              <div className="flex flex-col gap-2 rounded-md bg-edge-soft/60 p-3.5">
                <span className="text-[12px] font-semibold tracking-wider text-ink-3 uppercase">Formüller ve bu ayın sayıları</span>
                <div className="flex flex-col gap-2.5 font-mono text-[12.5px] leading-relaxed">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-ink-2">1 · kural yükü = Σ (kuralın istediği metrik × aylık değerlendirme sayısı)</span>
                    <span>
                      aylık değerlendirme = 30 gün ÷ grup aralığı = {fmtNum(30 * 86400)} sn ÷ 60 sn = {fmtNum(43200)}
                    </span>
                    <span className="text-ink">= <b>{fmtNum(at.rule_load_month)}</b> metrik / ay</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-ink-2">2 · dashboard yükü = Σ (panelin istediği metrik × (30 gün ÷ yenileme süresi))</span>
                    <span className="text-ink">= <b>{fmtNum(at.dashboard_load_month)}</b> metrik / ay</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-ink-2">3 · toplam ölçülen yük = 1 + 2</span>
                    <span className="text-ink">= {fmtNum(at.rule_load_month)} + {fmtNum(at.dashboard_load_month)} = <b>{fmtNum(at.total_load_month)}</b></span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-ink-2">4 · bir öğenin payı = gerçek fatura tutarı × (öğenin yükü ÷ toplam yük)</span>
                    <span>
                      kurallar = {usd(at.real_cost_month)} × ({fmtNum(at.rule_load_month)} ÷ {fmtNum(at.total_load_month)}) = <b className="text-ink">{usd(at.rule_cost_month)}</b>
                    </span>
                    <span>
                      dashboard'lar = {usd(at.real_cost_month)} × ({fmtNum(at.dashboard_load_month)} ÷ {fmtNum(at.total_load_month)}) = <b className="text-ink">{usd(at.dashboard_cost_month)}</b>
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-ink-2">5 · widget payı = dashboard'ın payı × (panelin metriği ÷ dashboard'ın metriği)</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-ink-2">metrik birim fiyatı = fatura tutarı ÷ faturalanan metrik</span>
                    <span>
                      = {usd(at.real_cost_month)} ÷ {fmtNum(at.real_metrics_month)} = <b className="text-ink">${(at.usd_per_metric * 1000).toFixed(4)} / 1000 metrik</b>
                    </span>
                  </div>
                </div>
              </div>
              {at.load_vs_billed != null && (
                <p className="text-[13px] text-ink-2">
                  Dürüst olmak gerekirse: ölçülen yük ayda {fmtNum(at.total_load_month)} metrik, yani faturalanan
                  {" "}{fmtNum(at.real_metrics_month)} metriğin <b className="font-semibold">{at.load_vs_billed} katı</b>.
                  Aradaki fark, Grafana'nın sorgu anında tam eşleşme ve gruplama yapıp tanımların eşleşebileceği her metriği
                  istememesinden geliyor. Bu yüzden ölçülen yük bir <b className="font-semibold">üst sınır</b>;
                  tutarlar da o üst sınıra göre paylaştırılmış paylar.
                </p>
              )}
              <p className="text-[13px] text-ink-3">
                {s.hidden_panels > 0 && `Kapalı satırdaki ${fmtNum(s.hidden_panels)} panel sayılmadı, çünkü satır açılmadan sorgu atmıyorlar. `}
                {s.unknown_targets > 0 && `${fmtNum(s.unknown_targets)} sorgunun veri kaynağı şablon değişkeni olduğu için sayıma girmedi.`}
              </p>
            </Panel>
          </Section>
        </>
      )}

      <span id="kirilim" className="scroll-mt-4" aria-hidden />
      <Section title="Dashboard ve widget kırılımı" aside="Satırı aç: hangi widget, hangi sorgu, nasıl düşürülür">
        {cwDash.length === 0 ? <Empty>CloudWatch sorgusu olan dashboard yok.</Empty> : (
          <>
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-[13.5px]">
                <thead>
                  <tr>
                    <th className={th}>Dashboard / widget</th>
                    <th className={thr}>Metrik sorgusu</th>
                    <th className={thr}>Logs</th>
                    <th className={thr}>Metrik / ay</th>
                    <th className={thr}>
                      <span className="inline-flex items-center gap-1.5">
                        Aylık pay
                        <Info title="Bu tutar nasıl çıktı" align="right">
                          Faturadaki gerçek metrik sorgusu tutarının bu dashboard'a düşen payı.
                          Pay, dashboard'ın ölçülen yüküne göre hesaplanıyor: CloudWatch sorgusu sayısı × yenileme sıklığı.
                          Widget satırlarında ise dashboard'ın payı, panelin sorgu sayısı oranında bölünüyor.
                        </Info>
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-soft">
                  {shownDash.map((x) => <DashRow key={`${x.org}-${x.uid}`} d={x} dup={dupTitles.has(x.title)} />)}
                </tbody>
              </table>
            </Panel>
            {cwDash.length > 12 && (
              <button type="button" onClick={() => setAllDash((v) => !v)} className="w-fit text-[13px] font-medium text-accent">
                {allDash ? "Daha az göster" : `${cwDash.length - 12} dashboard daha`}
              </button>
            )}
            <Panel className="flex flex-col gap-2 p-4 text-[14px]">
              <b className="font-semibold">Dashboard tarafında maliyeti düşüren üç değişiklik</b>
              <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-ink-2">
                <li><b className="font-medium text-ink">Yenilemeyi yavaşlat.</b> Maliyet doğrudan aynı oranda düşer: 10 saniyeden 1 dakikaya çıkmak altıya böler.</li>
                <li><b className="font-medium text-ink">Sorguya boyut ver.</b> Boyutu olmayan ya da joker içeren sorgular beklenenden çok metrik çeker.</li>
                <li><b className="font-medium text-ink">Kopyaları sil.</b> Aynı adı taşıyan dashboard'lar hem karışıklık hem iki kat sorgu demek.</li>
              </ol>
            </Panel>
          </>
        )}
      </Section>

      <span id="loglar" className="scroll-mt-4" aria-hidden />
      <Section title="Logs Insights kuralları" aside="Faturadaki tarama kalemini bu kurallar üretiyor">
        {d.log_rules.length === 0 ? <Empty>Logs Insights kullanan aktif kural yok.</Empty> : (
          <>
            <Panel className="flex items-start gap-3 border-crit/40 p-4">
              <TriangleAlert size={18} className="mt-0.5 shrink-0 text-crit" />
              <div className="flex flex-col gap-1.5 text-[14px]">
                <b className="font-semibold">Sorgu penceresi değerlendirme aralığından uzun olduğu sürece aynı loglar tekrar tekrar taranır.</b>
                <p className="text-ink-2">
                  30 dakikalık pencereyi her 60 saniyede çalıştıran kural, her dakika 30 dakikalık veriyi yeniden tarar.
                  Pencereyi aralığa yaklaştırmak ya da aralığı uzatmak tarama hacmini aynı oranda düşürür.
                  Warning ve Critical çiftleri aynı sorguyu çalıştırıyorsa tarama iki katına çıkar: tek kurala indirip eşikle ayırmak gerekir.
                </p>
              </div>
            </Panel>
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[13.5px]">
                <thead>
                  <tr>
                    <th className={th}>Kural</th><th className={thr}>Pencere</th><th className={thr}>Sıklık</th>
                    <th className={th}>
                      <span className="inline-flex items-center gap-1.5">
                        İsraf
                        <Info title="İsraf nasıl ölçüldü" align="right">
                          Sorgu penceresi ÷ değerlendirme aralığı. 30 dakikalık pencere her 60 saniyede çalışıyorsa
                          aynı veri 30 kez taranır. Kuralın tanımından okunur, tahmin içermez.
                        </Info>
                      </span>
                    </th>
                    <th className={thr}>Log grubu</th><th className={thr}>Tarama / ay</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-soft">
                  {d.log_rules.map((r) => <LogRuleRow key={r.uid} r={r} />)}
                </tbody>
              </table>
            </Panel>
          </>
        )}
      </Section>

      <Section title="7/24 çalışan metrik kuralları" aside={`${fmtNum(metricRules.length)} kural · faturadaki payı ${usd(at.rule_cost_month)}`}>
        {metricRules.length === 0 ? <Empty>CloudWatch metriği okuyan aktif kural yok.</Empty> : (
          <>
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-[13.5px]">
                <thead>
                  <tr>
                    <th className={th}>Kural</th><th className={th}>Grup</th><th className={thr}>Sıklık</th>
                    <th className={thr}>Sorgu</th><th className={thr}>Metrik / ay</th><th className={thr}>Aylık pay</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-soft">
                  {shownRules.map((r) => (
                    <tr key={r.uid}>
                      <td className={td}>
                        {r.title}
                        {!r.every_known && <span className="block text-[12px] text-warn">değerlendirme aralığı okunamadı, varsayılan kullanıldı</span>}
                        {r.expands > 0 && <span className="block text-[12px] text-warn">{r.expands} sorgu birden çok metriğe açılıyor</span>}
                      </td>
                      <td className={td}><span className="text-ink-2">{r.group}</span></td>
                      <td className={tdn}>{every(r.every_s)}</td>
                      <td className={tdn}>{r.metric_queries}</td>
                      <td className={tdn}>{r.real_metrics_month != null ? fmtNum(r.real_metrics_month) : "—"}</td>
                      <td className={tdn}>{usd(r.real_cost_month ?? r.metric_cost_month)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            {metricRules.length > 12 && (
              <button type="button" onClick={() => setAllRules((v) => !v)} className="w-fit text-[13px] font-medium text-accent">
                {allRules ? "Daha az göster" : `${metricRules.length - 12} kural daha`}
              </button>
            )}
          </>
        )}
      </Section>
    </>
  );
}

/** Logs Insights kuralının satırı: pencere, sıklık, israf ve taranan log grupları. */
function LogRuleRow({ r }: { r: CostRule }) {
  const [open, setOpen] = useState(false);
  const groups = r.logs.flatMap((l) => l.groups);
  return (
    <>
      {r.logs.map((l, i) => (
        <tr key={i}>
          <td className={td}>
            <span className="font-medium">{r.title}</span>
            <span className="block text-[12px] text-ink-3">{r.group}</span>
          </td>
          <td className={tdn}>{l.window_min} dk</td>
          <td className={tdn}>{every(r.every_s)}</td>
          <td className={td}>
            {l.overlap == null ? <span className="text-ink-3">—</span>
              : <Pill tone={l.overlap >= 10 ? "crit" : l.overlap >= 3 ? "warn" : "mute"}>{l.overlap}× yeniden</Pill>}
          </td>
          <td className={tdn}>
            {l.groups.length > 0
              ? <button type="button" onClick={() => setOpen((v) => !v)} className="font-mono text-accent">{l.groups.length}</button>
              : "—"}
          </td>
          <td className={tdn}>{fmtNum(r.evals_month)}</td>
        </tr>
      ))}
      {open && groups.length > 0 && (
        <tr>
          <td className={`${td} bg-canvas`} colSpan={6}>
            <span className="text-[12px] text-ink-3">Her taramada bakılan log grupları:</span>
            <p className="mt-1 font-mono text-[11.5px] leading-relaxed break-all">{groups.join("  ·  ")}</p>
          </td>
        </tr>
      )}
    </>
  );
}
