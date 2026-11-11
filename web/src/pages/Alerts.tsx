import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Search } from "lucide-react";
import { api } from "../lib/api";
import type { Summary } from "../lib/types";
import { fmtDate, fmtNum, ago } from "../lib/format";
import BarChart from "../components/BarChart";
import { Empty, ErrorBox, FINDING, FindingPill, Freshness, Loading, PageHeader, Panel, Pill, Section, Severity, Stat, td, tdn, th, thr } from "../components/ui";

const LEVEL = { crit: { tone: "crit", label: "Kritik" }, warn: { tone: "warn", label: "Uyarı" }, info: { tone: "mute", label: "Bilgi" } } as const;

export default function Alerts() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery<Summary>({ queryKey: ["summary"], queryFn: () => api("/alerts/summary") });
  const [search, setSearch] = useState("");
  const [sev, setSev] = useState<"" | "critical" | "warning">("");
  const [finding, setFinding] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const refresh = async () => {
    await qc.fetchQuery({ queryKey: ["summary"], queryFn: () => api("/alerts/summary?refresh=true") });
  };

  const rules = useMemo(() => {
    if (!q.data) return [];
    const s = search.toLocaleLowerCase("tr");
    return q.data.rules.filter((r) =>
      (!s || r.title.toLocaleLowerCase("tr").includes(s) || r.folder.toLocaleLowerCase("tr").includes(s)) &&
      (!sev || r.severity === sev) &&
      (!finding || r.findings.some((f) => f.code === finding)) &&
      (!onlyIssues || r.findings.some((f) => f.level !== "info")),
    );
  }, [q.data, search, sev, finding, onlyIssues]);

  if (q.isLoading) return <Loading label="Grafana'dan alert geçmişi çekiliyor (ilk yükleme ~15 sn)" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const t = d.totals;
  const findings = showAll ? d.findings : d.findings.filter((f) => f.level !== "info").slice(0, 8);
  const codes = Array.from(new Set(d.rules.flatMap((r) => r.findings.map((f) => f.code))));

  return (
    <>
      <PageHeader
        eyebrow="Alert sağlığı"
        title="Gelen alert'ler"
        actions={<Freshness at={d.fetched_at} onRefresh={refresh} busy={q.isFetching} />}
      >
        <p className="max-w-[72ch] text-[15px] text-ink-2">
          Son {d.window.days} günde Grafana'daki {t.rules} kuralın gerçekte nasıl davrandığı. Bulgular kurallardan otomatik çıkarılır;
          bir kurala tıklayınca tanımı, geçmişi, nereden bakılacağı ve agent ile araştırma seçeneği açılır.
        </p>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={fmtNum(t.fires)} label="tetiklenme" hint={`${t.incidents} olaya gruplandı`} />
        <Stat value={`%${t.short_pct.toFixed(0)}`} label="10 dk içinde kendiliğinden düzelmiş" tone={t.short_pct > 50 ? "warn" : undefined} />
        <Stat value={fmtNum(t.errors)} label="sorgu hatası (Error)" tone={t.errors > 100 ? "crit" : undefined} />
        <Stat value={fmtNum(t.preventable_fires)} label="bulgular düzeltilirse önlenebilecek tetiklenme (tahmin)" tone="good" />
      </div>

      <Section title="Önce düzeltilecekler" aside={
        <button type="button" className="text-accent" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Sadece önemlileri göster" : `Tüm bulgular (${d.findings.length})`}
        </button>
      }>
        {findings.length === 0 ? <Empty>Bu dönemde dikkat gerektiren bir bulgu yok.</Empty> : (
          <Panel className="divide-y divide-edge-soft">
            {findings.map((f, i) => (
              <Link
                key={`${f.rule.key}-${f.code}`}
                to={`/alerts/${f.rule.org}/${f.rule.uid}`}
                className="group grid grid-cols-[22px_1fr] gap-x-3 gap-y-1 p-4 hover:bg-edge-soft/50 sm:grid-cols-[26px_1fr_auto]"
              >
                <span className="pt-0.5 font-mono text-[12.5px] text-ink-3">{i + 1}</span>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={LEVEL[f.level].tone}>{FINDING[f.code]?.label ?? f.code}</Pill>
                    <span className="text-[13px] text-ink-2">{f.rule.title}</span>
                  </div>
                  <h3 className="text-[15px] font-semibold">{f.title}</h3>
                  <p className="text-[13.5px] leading-relaxed text-ink-2">{f.detail}</p>
                  <p className="text-[13.5px] text-ink"><span className="font-medium">Öneri:</span> <span className="text-ink-2">{f.suggestion}</span></p>
                </div>
                <div className="col-start-2 flex items-center gap-3 font-mono text-[12.5px] text-ink-2 sm:col-start-3 sm:flex-col sm:items-end sm:justify-between">
                  <div className="sm:text-right">
                    {f.impact.errors > 0 && <div><b className="text-[15px] font-medium text-ink">−{fmtNum(f.impact.errors)}</b> hata</div>}
                    {f.impact.fires > 0 && <div><b className="text-[15px] font-medium text-ink">−{fmtNum(f.impact.fires)}</b> tetiklenme</div>}
                  </div>
                  <span className="inline-flex items-center gap-1 font-sans text-[12.5px] font-medium text-accent">
                    Detay ve inceleme <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Link>
            ))}
          </Panel>
        )}
      </Section>

      <Section title="Zaman içinde">
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <Panel className="flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 className="font-semibold">Günlük tetiklenme</h3>
              <span className="text-[12.5px] text-ink-3">Alerting durumuna geçiş</span>
            </div>
            <BarChart data={d.daily.map((x) => ({ label: fmtDate(x.day), value: x.fires }))} color="var(--color-accent)" unit="tetiklenme" tickEvery={5} height={180} ariaLabel="Günlük tetiklenme" />
          </Panel>
          <Panel className="flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 className="font-semibold">Saate göre</h3>
              <span className="text-[12.5px] text-ink-3">İstanbul saati</span>
            </div>
            <BarChart data={d.hours.map((v, h) => ({ label: String(h).padStart(2, "0"), value: v }))} color="var(--color-accent)" unit="tetiklenme" tickEvery={6} height={180} ariaLabel="Saate göre tetiklenme" />
          </Panel>
        </div>
        <Panel className="flex flex-col gap-2 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h3 className="font-semibold">Günlük sorgu hatası</h3>
            <span className="text-[12.5px] text-ink-3">Kuralın sorgusu çalışamadı (Error)</span>
          </div>
          <BarChart data={d.daily.map((x) => ({ label: fmtDate(x.day), value: x.errors }))} color="var(--color-series-2)" unit="hata" tickEvery={5} height={150} ariaLabel="Günlük sorgu hatası" />
        </Panel>
      </Section>

      <Section title="Kurallar" aside={`${rules.length} / ${d.rules.length} kural`}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-60 flex-1 items-center gap-2 rounded-md border border-edge bg-panel px-2.5 py-1.5 text-sm">
            <Search size={15} className="text-ink-3" />
            <input id="rule-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Kural ya da klasör ara" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-3" />
          </label>
          <select id="rule-sev" value={sev} onChange={(e) => setSev(e.target.value as typeof sev)} className="rounded-md border border-edge bg-panel px-2.5 py-1.5 text-sm">
            <option value="">Tüm seviyeler</option><option value="critical">critical</option><option value="warning">warning</option>
          </select>
          <select id="rule-finding" value={finding} onChange={(e) => setFinding(e.target.value)} className="rounded-md border border-edge bg-panel px-2.5 py-1.5 text-sm">
            <option value="">Tüm bulgular</option>
            {codes.map((c) => <option key={c} value={c}>{FINDING[c]?.label ?? c}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input id="rule-issues" type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Sadece sorunlu
          </label>
        </div>
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[13.5px]">
            <thead><tr>
              <th className={th}>Kural</th><th className={th}>Seviye</th><th className={th}>Durum</th>
              <th className={thr}>Tetiklenme</th><th className={thr}>≤10 dk</th><th className={thr}>Ortanca</th><th className={thr}>Hata</th>
              <th className={th}>Bulgular</th><th className={thr}>Son</th>
            </tr></thead>
            <tbody className="divide-y divide-edge-soft">
              {rules.map((r) => (
                <tr key={r.key} className="cursor-pointer hover:bg-edge-soft/50" onClick={() => nav(`/alerts/${r.org}/${r.uid}`)}>
                  <td className={td}>
                    <Link to={`/alerts/${r.org}/${r.uid}`} className="font-medium hover:text-accent" onClick={(e) => e.stopPropagation()}>{r.title}</Link>
                    <div className="text-[12px] text-ink-3">{r.folder} · {r.group}{r.org !== 3 && " · Main Org"}</div>
                  </td>
                  <td className={td}><Severity value={r.severity} /></td>
                  <td className={td}>
                    {r.paused ? <Pill tone="mute">duraklatıldı</Pill> : r.state === "firing" ? <Pill tone="crit">alarmda</Pill> : r.health === "error" ? <Pill tone="crit">hata</Pill> : r.state === "pending" ? <Pill tone="warn">bekliyor</Pill> : <Pill tone="good">normal</Pill>}
                  </td>
                  <td className={tdn}>{r.fires || <span className="text-ink-3">0</span>}</td>
                  <td className={tdn}>{r.short || <span className="text-ink-3">0</span>}</td>
                  <td className={tdn}>{r.median != null ? `${r.median} dk` : "—"}</td>
                  <td className={tdn}>{r.errors ? <span className="text-crit">{fmtNum(r.errors)}</span> : <span className="text-ink-3">0</span>}</td>
                  <td className={td}><div className="flex flex-wrap gap-1">{r.findings.filter((f) => f.code !== "offhours").map((f) => <FindingPill key={f.code} code={f.code} />)}</div></td>
                  <td className={tdn}>{r.last_fired ? ago(r.last_fired) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rules.length === 0 && <div className="p-4"><Empty>Filtreye uyan kural yok.</Empty></div>}
        </Panel>
      </Section>
    </>
  );
}
