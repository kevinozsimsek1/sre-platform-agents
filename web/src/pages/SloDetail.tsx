import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Sparkles } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../lib/api";
import type { AgentInfo, AgentState, Objectives, SloService } from "../lib/types";
import { fmtDate, fmtNum, fmtPct } from "../lib/format";
import AgentPanel from "../components/AgentPanel";
import { BudgetCell, Burn } from "./Slo";
import { ErrorBox, Loading, PageHeader, Panel, Section, Stat, td, tdn, th, thr } from "../components/ui";

type Resp = {
  objectives: Objectives; service: SloService | null;
  daily: { t: number; requests: number; availability: number | null; latency: number | null }[];
  routes: { route: string; requests: number; errors_5xx: number; slow: number; p95_s: number | null }[];
  codes: { code: string; count: number }[];
  analysis: AgentState; agents: AgentInfo[]; agent_suggestion: { agent: string; reason: string };
};

const tick = { fill: "var(--color-ink-3)", fontSize: 10.5, fontFamily: "var(--font-mono)" };

function SliChart({ data, k, target, label }: { data: Resp["daily"]; k: "availability" | "latency"; target: number; label: string }) {
  const rows = data.map((d) => ({ label: fmtDate(d.t), v: d[k] == null ? null : +(d[k]! * 100).toFixed(3) }));
  const vals = rows.map((r) => r.v).filter((v): v is number => v != null);
  const min = Math.min(target * 100, ...vals);
  return (
    <div role="img" aria-label={label} style={{ height: 180 }}>
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: -10 }}>
          <CartesianGrid vertical={false} stroke="var(--color-edge-soft)" />
          <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: "var(--color-edge)" }} interval={4} />
          <YAxis tick={tick} tickLine={false} axisLine={false} domain={[Math.floor(min * 10) / 10, 100]} tickFormatter={(v) => `%${v}`} width={56} />
          <ReferenceLine y={target * 100} stroke="var(--color-crit)" strokeDasharray="4 4" label={{ value: "hedef", fill: "var(--color-crit)", fontSize: 10.5, position: "insideTopRight" }} />
          <Tooltip content={({ active, payload, label: l }) => active && payload?.length ? (
            <div className="rounded-md bg-ink px-2.5 py-1.5 font-mono text-xs text-canvas">{l}: %{payload[0].value}</div>) : null} />
          <Line dataKey="v" stroke="var(--color-accent)" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function SloDetail() {
  const { service = "" } = useParams();
  const q = useQuery<Resp>({ queryKey: ["slo", service], queryFn: () => api(`/slo/${encodeURIComponent(service)}`) });
  if (q.isLoading) return <Loading label="Route bazında hesaplanıyor" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const s = d.service;
  const o = d.objectives;

  return (
    <>
      <Link to="/slo" className="-mb-5 inline-flex w-fit items-center gap-1 text-[13px] text-ink-2 hover:text-ink"><ArrowLeft size={14} /> SLO ve hata bütçesi</Link>
      <PageHeader eyebrow="Servis SLO'su" title={service}
        actions={<a href="#agent" className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[13px] font-medium text-white"><Sparkles size={13} /> Agent ile araştır</a>} />

      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat value={fmtNum(s.requests)} label={`gerçek istek (${o.window_days} gün)`} />
          <Stat value={fmtPct(s.availability, 3)} label={`erişilebilirlik · hedef ${fmtPct(o.availability, 1)}`} tone={s.avail_left != null && s.avail_left < 0 ? "crit" : undefined} hint={<BudgetCell left={s.avail_left} />} />
          <Stat value={fmtPct(s.latency, 2)} label={`${o.latency_le_s * 1000} ms altı · hedef ${fmtPct(o.latency, 0)}`} tone={s.lat_left != null && s.lat_left < 0 ? "crit" : undefined} hint={<BudgetCell left={s.lat_left} />} />
          <Stat value={<span className="flex gap-3 text-[20px]"><Burn v={s.burn_1d.latency} /><Burn v={s.burn_7d.latency} /></span>} label="gecikme bütçesi tüketim hızı (1g · 7g)" />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="flex flex-col gap-2 p-4"><h3 className="font-semibold">Günlük erişilebilirlik</h3><SliChart data={d.daily} k="availability" target={o.availability} label="Günlük erişilebilirlik" /></Panel>
        <Panel className="flex flex-col gap-2 p-4"><h3 className="font-semibold">Günlük hızlı istek oranı</h3><SliChart data={d.daily} k="latency" target={o.latency} label="Günlük gecikme SLI" /></Panel>
      </div>

      <Section title="Route'lar" aside="Önce 5xx, sonra yavaş istek sayısına göre · p95 son 7 gün">
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead><tr><th className={th}>Route</th><th className={thr}>İstek</th><th className={thr}>5xx</th><th className={thr}>Yavaş</th><th className={thr}>Yavaş oranı</th><th className={thr}>p95</th></tr></thead>
            <tbody className="divide-y divide-edge-soft">
              {d.routes.map((r) => {
                const slowPct = r.requests ? r.slow / r.requests : 0;
                return (
                  <tr key={r.route}>
                    <td className={td + " font-mono text-[12.5px] break-all"}>{r.route}</td>
                    <td className={tdn}>{fmtNum(r.requests)}</td>
                    <td className={tdn}>{r.errors_5xx ? <span className="text-crit">{r.errors_5xx}</span> : <span className="text-ink-3">0</span>}</td>
                    <td className={tdn}>{fmtNum(r.slow)}</td>
                    <td className={tdn}><span className={slowPct > 0.05 ? "text-warn" : ""}>{fmtPct(slowPct, 1)}</span></td>
                    <td className={tdn}><span className={(r.p95_s ?? 0) > o.latency_le_s ? "text-warn" : ""}>{r.p95_s != null ? `${Math.round(r.p95_s * 1000)} ms` : "—"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
        <div className="flex flex-wrap gap-2 text-[12.5px] text-ink-2">
          {d.codes.filter((c) => c.count > 0).map((c) => (
            <span key={c.code} className="rounded border border-edge bg-panel px-2 py-0.5 font-mono"><b className={c.code.startsWith("5") ? "text-crit" : c.code.startsWith("4") ? "text-warn" : ""}>{c.code}</b> {fmtNum(c.count)}</span>
          ))}
        </div>
      </Section>

      <div id="agent" className="scroll-mt-6">
        <AgentPanel kind="slo" refId={service} agents={d.agents} suggestion={d.agent_suggestion} initial={d.analysis} title="Bu servisin yavaşlığını/hatalarını agent ile araştır" />
      </div>
    </>
  );
}
