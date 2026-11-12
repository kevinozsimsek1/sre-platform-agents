import { Fragment, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Search, Send, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import type { Episode, RuleDetail as RD } from "../lib/types";
import { fmtDate, fmtDateTime, fmtMin, fmtNum } from "../lib/format";
import BarChart from "../components/BarChart";
import Investigate, { GuideNote, type GuideItem } from "../components/Investigate";
import AgentPanel from "../components/AgentPanel";
import { RunbookPanel } from "../components/Runbook";
import { Code, Empty, ErrorBox, Loading, PageHeader, Panel, Pill, Section, Severity, Stat, td, tdn, th, thr } from "../components/ui";

const LEVEL_TONE = { crit: "crit", warn: "warn", info: "mute" } as const;

function EpisodeGuide({ org, uid, ep }: { org: string; uid: string; ep: Episode }) {
  const q = useQuery<{ guide: GuideItem[] }>({
    queryKey: ["ep-guide", org, uid, ep.start, ep.series],
    queryFn: () => api(`/alerts/rules/${org}/${uid}/investigate?start=${ep.start}${ep.end ? `&end=${ep.end}` : ""}&series=${encodeURIComponent(ep.series)}`),
  });
  if (q.isLoading) return <Loading label="Hazırlanıyor" inline />;
  if (q.error) return <ErrorBox error={q.error} />;
  return <Investigate items={q.data!.guide} compact />;
}

export default function RuleDetail() {
  const { org = "", uid = "" } = useParams();
  const q = useQuery<RD>({ queryKey: ["rule", org, uid], queryFn: () => api(`/alerts/rules/${org}/${uid}`) });
  const [open, setOpen] = useState<number | null>(null);
  const [focus, setFocus] = useState<Episode | null>(null);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const r = d.rule;

  return (
    <>
      <Link to="/alerts" className="-mb-5 inline-flex w-fit items-center gap-1 text-[13px] text-ink-2 hover:text-ink"><ArrowLeft size={14} /> Gelen alert'ler</Link>
      <PageHeader
        eyebrow={<>{r.folder} · {r.group}</>}
        title={r.title}
        actions={
          <>
            <a href={d.links.grafana} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-panel px-2.5 py-1 text-[13px] text-ink-2 hover:text-ink">Grafana'da aç <ExternalLink size={13} /></a>
            <a href="#agent" className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[13px] font-medium text-white"><Sparkles size={13} /> Agent ile araştır</a>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <Severity value={r.severity} />
          {r.paused ? <Pill tone="mute">duraklatılmış</Pill> : r.state === "firing" ? <Pill tone="crit">şu an alarmda</Pill> : r.health === "error" ? <Pill tone="crit">sorgu hatada</Pill> : <Pill tone="good">normal</Pill>}
          <span>bekleme (for): <Code>{r.for}</Code></span>
          <span>hata durumunda: <Code>{r.exec_err_state}</Code></span>
          <span>veri yoksa: <Code>{r.no_data_state}</Code></span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <Send size={14} className="text-ink-3" /> Bildirim gidiyor:
          {d.routing.length ? d.routing.map((c) => <Pill key={c.name} tone="accent">{c.name} · {c.type}</Pill>) : <span>—</span>}
        </div>
        {r.annotations.description && <p className="max-w-[80ch] text-[14px] text-ink-2">{r.annotations.description}</p>}
        {r.last_error && <p className="rounded-md bg-crit-soft px-3 py-2 text-[13px] text-crit">Son sorgu hatası: {r.last_error}</p>}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat value={fmtNum(r.fires)} label="tetiklenme (30 gün)" />
        <Stat value={d.p50 != null ? fmtMin(d.p50) : "—"} label="ortanca süre" hint={d.p90 != null ? `p90: ${fmtMin(d.p90)}` : undefined} />
        <Stat value={fmtNum(r.short)} label="10 dk içinde düzelen" />
        <Stat value={fmtNum(r.errors)} label="sorgu hatası" tone={r.errors > 20 ? "crit" : undefined} />
        <Stat value={fmtNum(r.nearmiss)} label="eşiğe gelip geri dönen (pending→normal)" />
      </div>

      <RunbookPanel d={d} />

      {d.findings.length > 0 && (
        <Section title="Bulgular">
          <div className="grid gap-3 md:grid-cols-2">
            {d.findings.map((f) => (
              <Panel key={f.code} className="flex flex-col gap-1.5 p-4">
                <Pill tone={LEVEL_TONE[f.level]}>{f.level === "crit" ? "Kritik" : f.level === "warn" ? "Uyarı" : "Bilgi"}</Pill>
                <h3 className="font-semibold">{f.title}</h3>
                <p className="text-[13.5px] leading-relaxed text-ink-2">{f.detail}</p>
                <p className="text-[13.5px]"><span className="font-medium">Öneri:</span> <span className="text-ink-2">{f.suggestion}</span></p>
              </Panel>
            ))}
          </div>
        </Section>
      )}

      <Section title="Nereden bakılır" aside="Son tetiklenmenin zaman aralığına göre">
        <Investigate items={d.investigate} />
        <GuideNote />
      </Section>

      <div id="agent" className="scroll-mt-6">
        <AgentPanel
          kind="rule"
          refId={r.key}
          agents={d.agents}
          suggestion={d.agent_suggestion}
          initial={d.analysis}
          episode={focus ? { start: focus.start, series: focus.series } : null}
          title={focus ? "Bu tetiklenmeyi agent ile araştır" : "Bu alert'i agent ile araştır"}
        />
      </div>

      <Section title="Tetiklenmeler" aside={`son ${d.episodes.length}`}>
        {d.episodes.length === 0 ? <Empty>Son 30 günde tetiklenmedi.</Empty> : (
          <Panel className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13.5px]">
              <thead><tr><th className={th}>Başlangıç</th><th className={thr}>Süre</th><th className={th}>Seri</th><th className={th}>Değer</th><th className={th} /></tr></thead>
              <tbody className="divide-y divide-edge-soft">
                {d.episodes.map((e) => (
                  <Fragment key={e.start + e.series}>
                    <tr className={open === e.start ? "bg-edge-soft/50" : ""}>
                      <td className={td + " whitespace-nowrap"}>
                        {fmtDateTime(e.start)}
                        {e.offhours && <span className="ml-1.5 text-[11.5px] text-ink-3">mesai dışı</span>}
                      </td>
                      <td className={tdn}>{e.end ? fmtMin(e.minutes) : <Pill tone="crit">açık</Pill>}</td>
                      <td className={td + " max-w-[320px] font-mono text-[12px] break-words text-ink-2"}>{e.series}</td>
                      <td className={td + " max-w-[220px] font-mono text-[12px] break-words text-ink-2"}>{e.value || "—"}</td>
                      <td className={td + " whitespace-nowrap text-right"}>
                        <button type="button" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent" onClick={() => setOpen(open === e.start ? null : e.start)} data-audit="Tetiklenmeyi incele">
                          <Search size={13} /> İncele
                        </button>
                        <button type="button" className="ml-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent"
                          onClick={() => { setFocus(e); document.getElementById("agent")?.scrollIntoView({ behavior: "smooth" }); }}>
                          <Sparkles size={13} /> Agent'a sor
                        </button>
                      </td>
                    </tr>
                    {open === e.start && (
                      <tr><td colSpan={5} className="bg-canvas px-3 py-3"><EpisodeGuide org={org} uid={uid} ep={e} /></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </Section>

      <Section title="Davranış">
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel className="flex flex-col gap-2 p-4 lg:col-span-2">
            <h3 className="font-semibold">Günlük tetiklenme ve hata</h3>
            <BarChart data={d.daily.map((x) => ({ label: fmtDate(x.day), value: x.fires }))} color="var(--color-accent)" unit="tetiklenme" tickEvery={5} height={150} ariaLabel="Günlük tetiklenme" />
            {r.errors > 0 && <BarChart data={d.daily.map((x) => ({ label: fmtDate(x.day), value: x.errors }))} color="var(--color-series-2)" unit="hata" tickEvery={5} height={110} ariaLabel="Günlük hata" />}
          </Panel>
          <Panel className="flex flex-col gap-2 p-4">
            <h3 className="font-semibold">Süre dağılımı</h3>
            <BarChart data={d.durations.map((x) => ({ label: x.label, value: x.count }))} color="var(--color-accent)" unit="tetiklenme" height={150} ariaLabel="Süre dağılımı" />
            <h3 className="mt-2 font-semibold">Saate göre</h3>
            <BarChart data={d.hours.map((v, h) => ({ label: String(h).padStart(2, "0"), value: v }))} color="var(--color-accent)" unit="tetiklenme" tickEvery={6} height={110} ariaLabel="Saate göre" />
          </Panel>
        </div>
      </Section>

      <Section title="Kural tanımı">
        <Panel className="divide-y divide-edge-soft">
          {d.queries.map((x) => (
            <div key={x.ref} className="grid gap-1 p-3.5 sm:grid-cols-[60px_200px_1fr]">
              <span className="font-mono text-[13px] font-medium">{x.ref}{x.condition && <span className="ml-1 text-[11px] text-accent">koşul</span>}</span>
              <span className="text-[12.5px] text-ink-2">{x.kind}{x.range && <span className="block text-ink-3">{x.range}</span>}</span>
              <pre className="min-w-0 overflow-x-auto font-mono text-[12.5px] whitespace-pre-wrap break-words">{x.text}</pre>
            </div>
          ))}
        </Panel>
        {Object.keys(r.labels).length > 0 && (
          <div className="flex flex-wrap gap-1.5">{Object.entries(r.labels).map(([k, v]) => <Code key={k}>{k}={v}</Code>)}</div>
        )}
      </Section>

      {d.errors.length > 0 && (
        <Section title="Sorgu hataları">
          <Panel className="divide-y divide-edge-soft">
            {d.errors.map((e) => (
              <div key={e.message} className="flex gap-3 p-3.5 text-[13px]">
                <span className="w-14 shrink-0 text-right font-mono text-crit">{e.count}×</span>
                <span className="min-w-0 font-mono text-[12.5px] break-words text-ink-2">{e.message}</span>
              </div>
            ))}
          </Panel>
        </Section>
      )}

      {d.series.length > 1 && (
        <Section title="Seriler" aside="Hangi kaynak ne kadar tetikledi">
          <Panel className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13.5px]">
              <thead><tr><th className={th}>Seri</th><th className={thr}>Tetiklenme</th><th className={thr}>Toplam süre</th><th className={thr}>Son</th></tr></thead>
              <tbody className="divide-y divide-edge-soft">
                {d.series.map((s) => (
                  <tr key={s.series}><td className={td + " font-mono text-[12px] break-words"}>{s.series}</td><td className={tdn}>{s.fires}</td><td className={tdn}>{fmtMin(s.minutes)}</td><td className={tdn}>{fmtDateTime(s.last)}</td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </Section>
      )}

      {d.incidents.length > 0 && (
        <Section title="Bu kuralın yer aldığı olaylar">
          <div className="flex flex-wrap gap-2">
            {d.incidents.slice(0, 20).map((i) => (
              <Link key={i.id} to={`/incidents/${i.id}`} className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[12.5px] text-ink-2 hover:border-accent hover:text-ink">
                {fmtDateTime(i.start)} · {fmtMin(i.minutes)}{i.rules.length > 1 && ` · ${i.rules.length} kural`}
              </Link>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
