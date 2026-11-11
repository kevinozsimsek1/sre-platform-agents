import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import type { IncidentDetail as ID } from "../lib/types";
import { fmtDateTime, fmtFull, fmtMin, fmtTime } from "../lib/format";
import Investigate, { GuideNote } from "../components/Investigate";
import AgentPanel from "../components/AgentPanel";
import { ErrorBox, Loading, PageHeader, Panel, Pill, Section, Severity, Stat } from "../components/ui";

/** Olaydaki alert'lerin zaman çizelgesi (gantt). */
function Timeline({ d }: { d: ID }) {
  const start = d.start;
  const end = d.end ?? Date.now();
  const span = Math.max(end - start, 60_000);
  const rows = d.timeline;
  const ticks = 4;
  return (
    <Panel className="overflow-x-auto p-4">
      <div className="min-w-[640px]">
        <div className="relative ml-[38%] h-5 border-b border-edge text-[11px] text-ink-3">
          {Array.from({ length: ticks + 1 }, (_, i) => (
            <span key={i} className="absolute -translate-x-1/2 font-mono" style={{ left: `${(i / ticks) * 100}%` }}>{fmtTime(start + (span * i) / ticks)}</span>
          ))}
        </div>
        <div className="flex flex-col">
          {rows.map((e, idx) => {
            const l = ((e.start - start) / span) * 100;
            const w = Math.max((((e.end ?? end) - e.start) / span) * 100, 0.8);
            return (
              <div key={idx} className="grid grid-cols-[38%_1fr] items-center border-b border-edge-soft py-1.5 text-[12.5px]">
                <div className="min-w-0 pr-3">
                  <Link to={`/alerts/${e.rule.key.replace(":", "/")}`} className="block truncate font-medium hover:text-accent">{e.rule.title}</Link>
                  <span className="block truncate font-mono text-[11px] text-ink-3">{e.series}</span>
                </div>
                <div className="relative h-5">
                  <div
                    className={`absolute top-1 h-3 rounded ${e.end ? "bg-accent" : "bg-crit"}`}
                    style={{ left: `${l}%`, width: `${Math.min(w, 100 - l)}%` }}
                    title={`${fmtTime(e.start)} → ${e.end ? fmtTime(e.end) : "açık"} · ${fmtMin(e.minutes)} · ${e.value}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

export default function IncidentDetail() {
  const { id = "" } = useParams();
  const q = useQuery<ID>({ queryKey: ["incident", id], queryFn: () => api(`/incidents/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;

  return (
    <>
      <Link to="/incidents" className="-mb-5 inline-flex w-fit items-center gap-1 text-[13px] text-ink-2 hover:text-ink"><ArrowLeft size={14} /> Olaylar</Link>
      <PageHeader
        eyebrow={<>Olay {d.id}</>}
        title={d.rules.length === 1 ? d.rules[0].title : `${d.rules[0].title} ve ${d.rules.length - 1} kural daha`}
        actions={<a href="#agent" className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[13px] font-medium text-white"><Sparkles size={13} /> Agent ile araştır</a>}
      >
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <Severity value={d.severity} />
          {d.ongoing ? <Pill tone="crit">hâlâ açık</Pill> : <Pill tone="good">kapandı</Pill>}
          {d.night ? <Pill tone="warn">gece</Pill> : d.offhours ? <Pill tone="mute">mesai dışı</Pill> : <Pill tone="mute">mesai içi</Pill>}
          {d.preventable && <Pill tone="mute">bilinen gürültü</Pill>}
          <span>{fmtFull(d.start)}{d.end ? ` → ${fmtTime(d.end)}` : ""}</span>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={fmtMin(d.minutes)} label="süre" />
        <Stat value={d.rules.length} label="kural" />
        <Stat value={d.episodes} label="alert (tetiklenme)" />
        <Stat value={d.series} label="etkilenen seri / kaynak" />
      </div>

      {d.preventable && (
        <Panel className="border-warn/40 bg-warn-soft/40 p-4 text-[14px]">
          Bu olaydaki kuralların hepsinde bilinen bir sorun var (titrek, bozuk, zamanlı ya da kopya). Kural düzeltilirse bu tür olaylar büyük ihtimalle hiç oluşmaz.
          Önce kural sayfasındaki öneriye bak.
        </Panel>
      )}

      <Section title="Zaman çizelgesi">
        <Timeline d={d} />
      </Section>

      <div id="agent" className="scroll-mt-6">
        <AgentPanel kind="incident" refId={d.id} agents={d.agents} suggestion={d.agent_suggestion} initial={d.analysis} title="Bu olayı agent ile araştır" />
      </div>

      <Section title="Nereden bakılır" aside="Olayın zaman aralığına ayarlı">
        {d.investigate.map((g) => (
          <div key={g.key} className="flex flex-col gap-2">
            {d.investigate.length > 1 && <h3 className="text-[14px] font-semibold text-ink-2">{g.rule}</h3>}
            <Investigate items={g.guide} />
          </div>
        ))}
        <GuideNote />
      </Section>

      <Section title="Kurallar">
        <div className="grid gap-3 md:grid-cols-2">
          {d.rules_detail.map((r) => (
            <Link key={r.key} to={`/alerts/${r.org}/${r.uid}`} className="group">
              <Panel className="flex h-full flex-col gap-1.5 p-4 transition-colors group-hover:border-accent">
                <div className="flex flex-wrap items-center gap-2"><Severity value={r.severity} /><span className="text-[12.5px] text-ink-3">{r.folder}</span></div>
                <span className="font-semibold">{r.title}</span>
                <span className="text-[13px] text-ink-2">30 günde {r.fires} tetiklenme · ortanca {r.median ?? "—"} dk · bekleme {r.for}</span>
                <span className="text-[12.5px] text-ink-3">Bildirim: {(d.routing[r.title] ?? []).map((c) => c.name).join(", ") || "—"}</span>
              </Panel>
            </Link>
          ))}
        </div>
      </Section>

      {d.findings.length > 0 && (
        <Section title="Bu kurallarla ilgili bulgular">
          <Panel className="divide-y divide-edge-soft">
            {d.findings.map((f, i) => (
              <div key={i} className="flex flex-col gap-1 p-3.5">
                <span className="text-[12.5px] text-ink-3">{f.rule}</span>
                <span className="font-medium">{f.title}</span>
                <span className="text-[13px] text-ink-2">{f.suggestion}</span>
              </div>
            ))}
          </Panel>
        </Section>
      )}

      <p className="text-[12.5px] text-ink-3">Olay kimliği başlangıç zamanından türetilir: {d.id} · {fmtDateTime(d.start)}</p>
    </>
  );
}
