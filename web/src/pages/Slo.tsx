import { useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Objectives, SloService } from "../lib/types";
import { fmtNum, fmtPct } from "../lib/format";
import { Bar, ErrorBox, Freshness, Loading, PageHeader, Panel, Pill, Section, Stat, td, tdn, th, thr, type Tone } from "../components/ui";

type Resp = { fetched_at: number; objectives: Objectives; services: SloService[] };

const STATUS: Record<SloService["status"], { tone: Tone; label: string }> = {
  breached: { tone: "crit", label: "bütçe aşıldı" },
  at_risk: { tone: "warn", label: "risk altında" },
  ok: { tone: "good", label: "hedefte" },
  low_traffic: { tone: "mute", label: "az trafik" },
};

export function BudgetCell({ left }: { left: number | null }) {
  if (left == null) return <span className="text-ink-3">—</span>;
  const tone = left < 0 ? "crit" : left < 0.25 ? "warn" : "good";
  return (
    <div className="flex min-w-28 items-center gap-2">
      <Bar value={Math.max(0, left)} tone={tone} />
      <span className={`w-14 shrink-0 text-right font-mono text-[12px] tabular-nums ${left < 0 ? "text-crit" : ""}`}>
        {left < 0 ? `−${fmtNum(Math.abs(left) * 100)}%` : `%${fmtNum(left * 100)}`}
      </span>
    </div>
  );
}

export function Burn({ v }: { v: number | null }) {
  if (v == null) return <span className="text-ink-3">—</span>;
  const c = v >= 14.4 ? "text-crit font-semibold" : v >= 1 ? "text-warn" : "text-ink-2";
  return <span className={c}>{v.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}×</span>;
}

export default function Slo() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery<Resp>({ queryKey: ["slo"], queryFn: () => api("/slo") });
  if (q.isLoading) return <Loading label="Prometheus'tan SLO hesaplanıyor" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const o = d.objectives;
  const count = (s: SloService["status"]) => d.services.filter((x) => x.status === s).length;

  return (
    <>
      <PageHeader eyebrow="Güvenilirlik" title="SLO ve hata bütçesi"
        actions={<Freshness at={d.fetched_at} busy={q.isFetching} onRefresh={() => qc.fetchQuery({ queryKey: ["slo"], queryFn: () => api("/slo?refresh=true") })} />}>
        <p className="max-w-[78ch] text-[15px] text-ink-2">
          Prod servislerinin gerçek kullanıcı isteklerinden ölçülen güvenilirliği (OpenTelemetry, son {o.window_days} gün). Sağlık kontrolü istekleri sayılmaz.
          Hedefler: erişilebilirlik <b className="font-medium text-ink">{fmtPct(o.availability, 1)}</b>, isteklerin <b className="font-medium text-ink">{fmtPct(o.latency, 0)}</b>'i <b className="font-medium text-ink">{o.latency_le_s * 1000} ms</b> altında.
        </p>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={count("breached")} label="hata bütçesini aşan servis" tone={count("breached") ? "crit" : "good"} />
        <Stat value={count("at_risk")} label="bütçesinin %75'inden fazlasını harcamış" tone={count("at_risk") ? "warn" : undefined} />
        <Stat value={count("ok")} label="hedefte" tone="good" />
        <Stat value={count("low_traffic")} label={`${fmtNum(o.min_requests)} istekten az (anlamlı değil)`} />
      </div>

      <Section title="Servisler" aside="Satıra tıklayınca route bazında detay ve günlük seyir açılır">
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-[13.5px]">
            <thead><tr>
              <th className={th}>Servis</th><th className={th}>Durum</th><th className={thr}>İstek</th>
              <th className={thr}>Erişilebilirlik</th><th className={th}>Bütçe (5xx)</th>
              <th className={thr}>Hızlı istek</th><th className={th}>Bütçe (gecikme)</th>
              <th className={thr} title="7 günlük bütçe tüketim hızı. 1× = bütçe tam dönem sonunda biter.">Tüketim 7g</th>
            </tr></thead>
            <tbody className="divide-y divide-edge-soft">
              {d.services.map((s) => (
                <tr key={s.service} className={`cursor-pointer hover:bg-edge-soft/50 ${s.status === "low_traffic" ? "opacity-70" : ""}`} onClick={() => nav(`/slo/${encodeURIComponent(s.service)}`)}>
                  <td className={td}><Link to={`/slo/${encodeURIComponent(s.service)}`} className="font-medium hover:text-accent" onClick={(e) => e.stopPropagation()}>{s.service}</Link></td>
                  <td className={td}><Pill tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Pill></td>
                  <td className={tdn}>{fmtNum(s.requests)}</td>
                  <td className={tdn}>{fmtPct(s.availability, 3)}</td>
                  <td className={td}><BudgetCell left={s.avail_left} /></td>
                  <td className={tdn}>{fmtPct(s.latency, 2)}</td>
                  <td className={td}><BudgetCell left={s.lat_left} /></td>
                  <td className={tdn}><Burn v={Math.max(s.burn_7d.availability ?? 0, s.burn_7d.latency ?? 0)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </Section>

      <Panel className="grid gap-3 p-4 text-[13.5px] text-ink-2 md:grid-cols-3">
        <p><b className="font-medium text-ink">Hata bütçesi</b>: hedefin izin verdiği kötü istek payı. {fmtPct(o.availability, 1)} hedefte her {fmtNum(1 / (1 - o.availability))} istekten 1'i hata verebilir. Kalan bütçe negatifse hedef aşılmış demektir.</p>
        <p><b className="font-medium text-ink">Tüketim hızı (burn rate)</b>: bütçenin ne hızla harcandığı. 1× dönem sonunda tam biter; 14,4× ve üstü (Google SRE eşiği) acil müdahale gerektirir.</p>
        <p><b className="font-medium text-ink">Hedefler varsayılandır.</b> Uzun süren işler yapan servisler (ör. workflow) için gecikme hedefi servis sahipleriyle ayrıca belirlenmeli.</p>
      </Panel>
    </>
  );
}
