import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bot } from "lucide-react";
import { api } from "../lib/api";
import type { Finding, Incident, RuleRef, RuleRow, SloService } from "../lib/types";
import { ago, fmtDateTime, fmtMin, fmtNum } from "../lib/format";
import { AssigneeTag } from "../components/Team";
import { Empty, ErrorBox, FINDING, Freshness, Loading, PageHeader, Panel, Pill, Section, Severity, Stat, type Tone } from "../components/ui";

type Resp = {
  fetched_at: number;
  alerts: { fires: number; incidents: number; firing_now: number; rules_with_findings: number; preventable_fires: number; top_findings: (Finding & { rule: RuleRef })[] };
  firing: RuleRow[];
  incidents_24h: Incident[];
  slo: Record<"breached" | "at_risk" | "ok" | "low_traffic", number>;
  slo_attention: SloService[];
  gpu: { available: boolean; running?: boolean; hours?: number; cost_usd?: number; failed_launches?: number; reason?: string };
};

type Health = "checking" | "up" | "down";
const AGENTS = [
  { id: "cloudwatch", name: "CloudWatch agent", href: "/cloudwatch/", probe: "/cloudwatch/ready" },
  { id: "eks", name: "EKS agent", href: "/eks/", probe: "/eks/health" },  // EKS agent'ta /ready yok, /health var
];
const H: Record<Health, { tone: Tone; label: string }> = { checking: { tone: "mute", label: "kontrol ediliyor" }, up: { tone: "good", label: "hazır" }, down: { tone: "mute", label: "kapalı" } };

function useAgentHealth() {
  const [h, setH] = useState<Record<string, Health>>({});
  useEffect(() => {
    AGENTS.forEach(async (a) => {
      setH((p) => ({ ...p, [a.id]: "checking" }));
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(a.probe, { signal: ctrl.signal, cache: "no-store" });
        clearTimeout(t);
        setH((p) => ({ ...p, [a.id]: r.ok ? "up" : "down" }));
      } catch { setH((p) => ({ ...p, [a.id]: "down" })); }
    });
  }, []);
  return h;
}

type ClusterSum = { summary: { nodes: number; nodes_ready: number; problem_pods: number; restarting_pods: number; workloads: number; jobs_failed: number; certs_soon: number; pvcs_full: number } };

export default function Overview() {
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ["overview"], queryFn: () => api("/overview"), refetchInterval: 120_000 });
  const cl = useQuery<ClusterSum>({ queryKey: ["cluster"], queryFn: () => api("/cluster"), staleTime: 60_000, retry: false });
  const health = useAgentHealth();

  if (q.isLoading) return <Loading label="Grafana, Prometheus ve AWS'den durum toplanıyor (ilk açılış ~15 sn)" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const openInc = d.incidents_24h.filter((i) => i.ongoing);
  const unassigned = openInc.filter((i) => !i.assignee);
  const critFiring = d.firing.filter((f) => f.severity === "critical");
  const calm = openInc.length === 0 && critFiring.length === 0;
  // Önce critical, sonra en çok seri: alarmda olanlar önem sırasına göre
  const firing = [...d.firing].sort((a, b) =>
    (b.severity === "critical" ? 1 : 0) - (a.severity === "critical" ? 1 : 0) || (b.active ?? 0) - (a.active ?? 0));
  const cs = cl.data?.summary;

  return (
    <>
      <PageHeader eyebrow="Nebim SRE Portal" title="Genel bakış"
        actions={<Freshness at={d.fetched_at} busy={q.isFetching} onRefresh={() => qc.fetchQuery({ queryKey: ["overview"], queryFn: () => api("/overview?refresh=true") })} />}>
        <p className="max-w-[76ch] text-[15px] text-ink-2">Prod'un şu anki durumu: alarmda olanlar, son 24 saatin olayları, SLO'su risk altındaki servisler ve önce düzeltilmesi gereken alert'ler.</p>
      </PageHeader>

      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 text-[14.5px] ${calm ? "border-good/30 bg-good-soft/50" : "border-crit/40 bg-crit-soft/60"}`} role="status">
        <span className={`size-2.5 shrink-0 rounded-full ${calm ? "bg-good" : "bg-crit motion-safe:animate-pulse"}`} aria-hidden />
        {calm ? (
          <span><b className="font-semibold">Prod sakin.</b> <span className="text-ink-2">Şu an açık olay ve alarmda critical kural yok.</span></span>
        ) : (
          <span>
            <b className="font-semibold">Dikkat:</b>{" "}
            {openInc.length > 0 && <Link to={`/incidents/${openInc[0].id}`} className="underline-offset-2 hover:underline">{openInc.length} açık olay</Link>}
            {openInc.length > 0 && critFiring.length > 0 && ", "}
            {critFiring.length > 0 && <Link to={`/alerts/${critFiring[0].org}/${critFiring[0].uid}`} className="underline-offset-2 hover:underline">{critFiring.length} critical alert alarmda</Link>}
          </span>
        )}
        {unassigned.length > 0 && (
          <Link to="/work" className="inline-flex items-center gap-1.5 rounded-full bg-crit px-2.5 py-0.5 text-[12.5px] font-semibold text-white">
            {unassigned.length} olay kimsede değil
          </Link>
        )}
        {d.slo.breached > 0 && (
          <Link to="/slo" className="text-ink-2 underline-offset-2 hover:underline sm:ml-auto">{d.slo.breached} servis SLO hedefinin dışında</Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Link to="/alerts" className="group"><Stat value={d.firing.length} label="kural şu an alarmda" tone={critFiring.length ? "crit" : d.firing.length ? "warn" : "good"}
          hint={critFiring.length ? `${critFiring.length} tanesi critical` : "critical yok"} /></Link>
        <Link to="/incidents" className="group"><Stat value={d.incidents_24h.length} label="olay (son 24 saat)" tone={openInc.length ? "warn" : undefined}
          hint={openInc.length ? `${openInc.length} tanesi hâlâ açık` : "hepsi kapandı"} /></Link>
        <Link to="/slo" className="group"><Stat value={d.slo.breached} label="servis SLO hedefini aşmış" tone={d.slo.breached ? "crit" : "good"} hint={`${d.slo.at_risk} servis risk altında`} /></Link>
        <Link to="/alerts" className="group"><Stat value={d.alerts.rules_with_findings} label="kuralda düzeltilecek sorun" tone={d.alerts.rules_with_findings ? "warn" : "good"} hint={`~${fmtNum(d.alerts.preventable_fires)} tetiklenme önlenebilir`} /></Link>
      </div>

      {cs && (
        <Section title="Cluster durumu" aside={<Link to="/cluster" className="text-accent">Ayrıntı</Link>}>
          <Panel className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-[14px]">
            <span className="inline-flex items-center gap-2">
              <span className={`size-2.5 rounded-full ${cs.nodes_ready === cs.nodes ? "bg-good" : "bg-crit"}`} aria-hidden />
              <b className="font-semibold">{cs.nodes_ready}/{cs.nodes}</b> <span className="text-ink-2">node hazır</span>
            </span>
            {[["sorunlu pod", cs.problem_pods, "crit"], ["24 saatte restart eden pod", cs.restarting_pods, "warn"],
              ["eksik iş yükü", cs.workloads, "warn"], ["başarısız job", cs.jobs_failed, "warn"],
              ["21 günde dolacak sertifika", cs.certs_soon, "warn"], ["%80 üstü dolu disk", cs.pvcs_full, "warn"]]
              .filter(([, n]) => (n as number) > 0)
              .map(([label, n, tone]) => (
                <span key={label as string} className="inline-flex items-baseline gap-1.5">
                  <b className={`font-mono font-semibold tabular-nums ${tone === "crit" ? "text-crit" : "text-warn"}`}>{n as number}</b>
                  <span className="text-ink-2">{label as string}</span>
                </span>
              ))}
            {cs.problem_pods + cs.restarting_pods + cs.workloads + cs.jobs_failed + cs.certs_soon + cs.pvcs_full === 0 && (
              <span className="text-ink-2">Pod, sertifika ve disk tarafında sorun yok.</span>
            )}
          </Panel>
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Şu an alarmda" aside={<Link to="/alerts" className="text-accent">Tüm kurallar</Link>}>
          {d.firing.length === 0 ? <Empty>Şu an alarmda kural yok.</Empty> : (
            <Panel className="divide-y divide-edge-soft">
              {firing.map((r) => (
                <Link key={r.key} to={`/alerts/${r.org}/${r.uid}`} className="flex items-center gap-3 p-3.5 hover:bg-edge-soft/50">
                  <Severity value={r.severity} />
                  <span className="min-w-0 flex-1 truncate font-medium">{r.title}</span>
                  {r.active > 1 && <span className="text-[12px] text-ink-3">{r.active} seri</span>}
                  <ArrowRight size={14} className="text-ink-3" />
                </Link>
              ))}
            </Panel>
          )}
        </Section>

        <Section title="Son 24 saatin olayları" aside={<Link to="/incidents" className="text-accent">Tüm olaylar</Link>}>
          {d.incidents_24h.length === 0 ? <Empty>Son 24 saatte olay yok.</Empty> : (
            <Panel className="divide-y divide-edge-soft">
              {d.incidents_24h.slice(0, 7).map((i) => (
                <Link key={i.id} to={`/incidents/${i.id}`} className="flex items-center gap-3 p-3.5 hover:bg-edge-soft/50">
                  <span className="w-28 shrink-0 font-mono text-[12px] text-ink-2">{fmtDateTime(i.start)}</span>
                  <span className="min-w-0 flex-1 truncate">{i.rules[0]?.title}{i.rules.length > 1 && <span className="text-ink-3"> +{i.rules.length - 1}</span>}</span>
                  <AssigneeTag a={i.assignee} />
                  {i.ongoing
                    ? <Pill tone="crit">{fmtMin(i.minutes)}'dir açık</Pill>
                    : <span className="font-mono text-[12px] text-ink-3">{fmtMin(i.minutes)}</span>}
                </Link>
              ))}
            </Panel>
          )}
        </Section>
      </div>

      <Section title="Hedefinin altında kalan servisler" aside={<Link to="/slo" className="text-accent">Tüm servisler</Link>}>
        {d.slo_attention.length === 0 ? <Empty>Tüm servisler hedefte.</Empty> : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {d.slo_attention.map((s) => (
              <Link key={s.service} to={`/slo/${encodeURIComponent(s.service)}`} className="group">
                <Panel className="flex h-full flex-col gap-1.5 p-4 transition-colors group-hover:border-accent">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{s.service}</span>
                    <Pill tone={s.status === "breached" ? "crit" : "warn"}>{s.status === "breached" ? "hedefin altında" : "sınırda"}</Pill>
                  </div>
                  <span className="text-[13px] text-ink-2">{s.explain}</span>
                  <span className="text-[12.5px] text-ink-3">{fmtNum(s.measured?.requests)} istek · hedef %{(s.target.latency_target * 100).toFixed(0)} · {fmtNum(s.target.latency_ms)} ms</span>
                </Panel>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title="Önce düzeltilecek alert'ler" aside={<Link to="/alerts" className="text-accent">Tüm bulgular</Link>}>
        <Panel className="divide-y divide-edge-soft">
          {d.alerts.top_findings.map((f) => (
            <Link key={f.rule.key + f.code} to={`/alerts/${f.rule.org}/${f.rule.uid}`} className="flex flex-col gap-1 p-3.5 hover:bg-edge-soft/50 sm:flex-row sm:items-center sm:gap-3">
              <Pill tone={f.level === "crit" ? "crit" : f.level === "warn" ? "warn" : "mute"}>{FINDING[f.code]?.label ?? f.code}</Pill>
              <span className="min-w-0 flex-1"><span className="font-medium">{f.rule.title}</span><span className="text-ink-2"> · {f.title}</span></span>
              <span className="shrink-0 font-mono text-[12px] text-ink-3">{f.impact.errors ? `−${fmtNum(f.impact.errors)} hata` : f.impact.fires ? `−${f.impact.fires} tetiklenme` : ""}</span>
            </Link>
          ))}
        </Panel>
      </Section>

      <Section title="Agent sohbetleri">
        <div className="grid gap-3 sm:grid-cols-2">
          {AGENTS.map((a) => {
            const h = H[health[a.id] ?? "checking"];
            return (
              <a key={a.id} href={a.href} className="group">
                <Panel className="flex h-full items-center gap-3 p-4 transition-colors group-hover:border-accent">
                  <span className="grid size-9 place-items-center rounded-md bg-edge-soft text-ink-2"><Bot size={18} /></span>
                  <div className="flex min-w-0 flex-1 flex-col"><span className="font-semibold">{a.name}</span><span className="text-[12.5px] text-ink-3">Sohbeti aç</span></div>
                  <Pill tone={h.tone}>{h.label}</Pill>
                </Panel>
              </a>
            );
          })}
        </div>
        <p className="text-[12.5px] text-ink-3">Veri {ago(d.fetched_at)} toplandı.</p>
      </Section>
    </>
  );
}
