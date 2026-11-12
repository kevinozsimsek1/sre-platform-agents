import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, Sparkles } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../lib/api";
import type { AgentInfo, AgentState, SloService } from "../lib/types";
import { fmtDate, fmtNum, fmtPct } from "../lib/format";
import AgentPanel from "../components/AgentPanel";
import { STATUS, SourcePill, TargetText, Trend } from "./Slo";
import { Code, ErrorBox, Loading, PageHeader, Panel, Pill, Section, Stat, td, tdn, th, thr } from "../components/ui";

type Resp = {
  window_days: number; targets_file: string; service: SloService | null;
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
          <YAxis tick={tick} tickLine={false} axisLine={false} domain={[Math.max(0, Math.floor(min - 1)), 100]} tickFormatter={(v) => `%${v}`} width={52} />
          <ReferenceLine y={target * 100} stroke="var(--color-crit)" strokeDasharray="4 4" label={{ value: "hedef", fill: "var(--color-crit)", fontSize: 10.5, position: "insideTopRight" }} />
          <Tooltip content={({ active, payload, label: l }) => active && payload?.length ? (
            <div className="rounded-md bg-ink px-2.5 py-1.5 font-mono text-xs text-canvas">{l}: %{payload[0].value}</div>) : null} />
          <Line dataKey="v" stroke="var(--color-accent)" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Suggestion({ s, file, days }: { s: SloService; file: string; days: number }) {
  const [ok, setOk] = useState(false);
  const g = s.suggested;
  if (!g.availability && !g.latency_ms) return null;
  const snippet = [
    `[services."${s.service}"]`,
    g.latency_ms != null ? `latency_ms = ${g.latency_ms}` : null,
    g.latency_target != null ? `latency_target = ${(g.latency_target * 100).toFixed(1)}` : null,
    g.availability != null ? `availability = ${+(g.availability * 100).toFixed(2)}` : null,
    `owner = "<ekip adı>"`,
    `note = "<bu hedef neden böyle>"`,
  ].filter(Boolean).join("\n");
  const same = g.latency_ms === s.target.latency_ms && g.availability === s.target.availability;
  return (
    <Panel className="flex flex-col gap-3 p-5">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold">Önerilen hedef</h3>
        <p className="text-[13.5px] text-ink-2">
          Son {days} günün gerçek performansına göre bu servisin bugün tutturabileceği en iddialı standart seviye:
          {" "}<b className="font-medium text-ink"><TargetText t={g} /></b>.
          {same ? " Mevcut hedefle aynı." : " Hedefi koymak servis sahibinin kararı; öneri sadece veriyle başlangıç noktası verir."}
        </p>
        {s.p95_ms != null && s.p99_ms != null && (
          <p className="text-[12.5px] text-ink-3">İsteklerin %95'i {fmtNum(s.p95_ms)} ms, %99'u {fmtNum(s.p99_ms)} ms içinde tamamlanıyor (yaklaşık, histogram sınırlarına göre).</p>
        )}
      </div>
      {!same && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] text-ink-2">Kabul edilirse <Code>{file}</Code> dosyasına eklenecek satırlar:</span>
          <div className="relative">
            <pre className="overflow-x-auto rounded-md bg-canvas p-3 font-mono text-[12.5px]">{snippet}</pre>
            <button type="button" aria-label="Kopyala" className="absolute top-2 right-2 rounded border border-edge bg-panel p-1 text-ink-3 hover:text-ink"
              onClick={() => navigator.clipboard?.writeText(snippet).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }).catch(() => {})}>
              {ok ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function SloDetail() {
  const { service = "" } = useParams();
  const q = useQuery<Resp>({ queryKey: ["slo", service], queryFn: () => api(`/slo/${encodeURIComponent(service)}`) });
  if (q.isLoading) return <Loading label="Route bazında hesaplanıyor" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const s = d.service;
  const m = s?.measured;
  const t = s?.target;

  return (
    <>
      <Link to="/slo" className="-mb-5 inline-flex w-fit items-center gap-1 text-[13px] text-ink-2 hover:text-ink"><ArrowLeft size={14} /> Servis hedefleri</Link>
      <PageHeader eyebrow="Servis hedefi" title={service}
        actions={<a href="#agent" className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[13px] font-medium text-white"><Sparkles size={13} /> Agent ile araştır</a>}>
        {s && t && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <Pill tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Pill>
              <span className="text-ink-2">Hedef:</span> <b className="font-medium"><TargetText t={t} /></b>
              <SourcePill t={t} />
            </div>
            {t.note && <p className="text-[13.5px] text-ink-2">Gerekçe: {t.note}</p>}
            {s.explain && s.status !== "low_traffic" && <p className="text-[15px]">{s.explain}</p>}
          </div>
        )}
      </PageHeader>

      {s && m && t && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat value={fmtNum(m.requests)} label={`gerçek kullanıcı isteği (${d.window_days} gün)`} />
          <Stat value={fmtPct(m.latency, 1)} label={`${fmtNum(t.latency_ms)} ms altında yanıt · hedef ${fmtPct(t.latency_target, 0)}`} tone={m.latency < t.latency_target ? "crit" : "good"}
            hint={`İzin verilen yavaş istek ${fmtNum(s.allowed.slow)}, gerçekleşen ${fmtNum(m.slow)}`} />
          <Stat value={fmtPct(m.availability, 2)} label={`hatasız yanıt · hedef ${fmtPct(t.availability, 1)}`} tone={m.availability < t.availability ? "crit" : "good"}
            hint={`İzin verilen hata ${fmtNum(s.allowed.errors)}, gerçekleşen ${fmtNum(m.errors_5xx)}`} />
          <Stat value={<span className="text-[20px]"><Trend v={s.trend} /></span>} label="son 7 gün, 30 günlük ortalamaya göre" />
        </div>
      )}

      {s && <Suggestion s={s} file={d.targets_file} days={d.window_days} />}

      {t && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel className="flex flex-col gap-2 p-4"><h3 className="font-semibold">Günlük hızlı yanıt oranı</h3><SliChart data={d.daily} k="latency" target={t.latency_target} label="Günlük hızlı yanıt oranı" /></Panel>
          <Panel className="flex flex-col gap-2 p-4"><h3 className="font-semibold">Günlük hatasız yanıt oranı</h3><SliChart data={d.daily} k="availability" target={t.availability} label="Günlük hatasız yanıt oranı" /></Panel>
        </div>
      )}

      <Section title="Hangi işlemler yavaş ya da hatalı" aside="Önce hata, sonra yavaş istek sayısına göre · p95 son 7 gün">
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead><tr><th className={th}>İşlem (route)</th><th className={thr}>İstek</th><th className={thr}>5xx</th><th className={thr}>Yavaş</th><th className={thr}>Yavaş oranı</th><th className={thr}>p95</th></tr></thead>
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
                    <td className={tdn}><span className={t && (r.p95_s ?? 0) * 1000 > t.latency_ms ? "text-warn" : ""}>{r.p95_s != null ? `${fmtNum(r.p95_s * 1000)} ms` : "—"}</span></td>
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
        <AgentPanel kind="slo" refId={service} agents={d.agents} suggestion={d.agent_suggestion} initial={d.analysis} title="Bu servisin yavaşlığını ya da hatalarını agent ile araştır" />
      </div>
    </>
  );
}
