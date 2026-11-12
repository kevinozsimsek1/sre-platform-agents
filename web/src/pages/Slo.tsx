import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { api } from "../lib/api";
import type { SloList, SloService, SloTarget } from "../lib/types";
import { fmtNum, fmtPct } from "../lib/format";
import { Code, ErrorBox, Freshness, Loading, PageHeader, Panel, Pill, Section, Stat, td, tdn, th, thr, type Tone } from "../components/ui";

export const STATUS: Record<SloService["status"], { tone: Tone; label: string }> = {
  breached: { tone: "crit", label: "hedefin altında" },
  at_risk: { tone: "warn", label: "sınırda" },
  ok: { tone: "good", label: "hedefte" },
  low_traffic: { tone: "mute", label: "az trafik" },
};

const pct = (x: number, d = 1) => fmtPct(x, x >= 0.9995 && x < 1 ? 2 : d);

/** "isteklerin %99'u 500 ms altında · %99,9 hatasız" */
export function TargetText({ t }: { t: { availability?: number; latency_ms?: number; latency_target?: number } }) {
  return (
    <span>
      {t.latency_ms != null && t.latency_target != null && <>isteklerin {pct(t.latency_target, 0)}'i {fmtNum(t.latency_ms)} ms altında</>}
      {t.availability != null && <>{t.latency_ms != null && " · "}{pct(t.availability)} hatasız</>}
    </span>
  );
}

export function SourcePill({ t }: { t: SloTarget }) {
  return t.source === "tanımlı"
    ? <Pill tone="accent" title={t.owner ?? undefined}>tanımlı{t.owner ? ` · ${t.owner}` : ""}</Pill>
    : <Pill tone="mute" title="Bu servis için hedef tanımlanmamış; varsayılan kullanılıyor">varsayılan</Pill>;
}

export function Trend({ v }: { v: SloService["trend"] }) {
  if (v === "worse") return <span className="inline-flex items-center gap-1 text-crit"><ArrowDownRight size={14} /> kötüleşiyor</span>;
  if (v === "better") return <span className="inline-flex items-center gap-1 text-good"><ArrowUpRight size={14} /> iyileşiyor</span>;
  if (v === "same") return <span className="inline-flex items-center gap-1 text-ink-3"><Minus size={14} /> aynı</span>;
  return <span className="text-ink-3">—</span>;
}

export default function Slo() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery<SloList>({ queryKey: ["slo"], queryFn: () => api("/slo") });
  if (q.isLoading) return <Loading label="Prometheus'tan servis hedefleri hesaplanıyor" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const count = (s: SloService["status"]) => d.services.filter((x) => x.status === s).length;
  const defined = d.services.filter((s) => s.target.source === "tanımlı").length;

  return (
    <>
      <PageHeader eyebrow="Güvenilirlik" title="Servis hedefleri (SLO)"
        actions={<Freshness at={d.fetched_at} busy={q.isFetching} onRefresh={() => qc.fetchQuery({ queryKey: ["slo"], queryFn: () => api("/slo?refresh=true") })} />}>
        <p className="max-w-[78ch] text-[15px] text-ink-2">
          Her servisin kullanıcıya ne kadar iyi hizmet verdiği: istekler yeterince hızlı mı, hata dönüyor mu. Ölçüm gerçek kullanıcı isteklerinden yapılır,
          sağlık kontrolleri sayılmaz. Son {d.window_days} gün.
        </p>
      </PageHeader>

      <Panel className="grid gap-4 p-5 md:grid-cols-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Hedef nedir?</h3>
          <p className="text-[13.5px] text-ink-2">
            Servisin kullanıcıya verdiği söz. Örneğin "isteklerin %99'u 500 ms altında yanıt versin ve %99,9'u hatasız olsun".
            Gerçekleşen değer hedefin altına düşerse kullanıcılar bunu hissediyor demektir.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Hedefi kim belirliyor?</h3>
          <p className="text-[13.5px] text-ink-2">
            Servisin sahibi ekip. Hedefler repodaki <Code>{d.targets_file}</Code> dosyasında, kodla birlikte tutulur; her değişiklik git geçmişinde görünür.
            Şu an {d.services.length} servisin <b className="font-medium text-ink">{defined}</b> tanesi için hedef tanımlı.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Tanımlı değilse?</h3>
          <p className="text-[13.5px] text-ink-2">
            Varsayılan kullanılır: <TargetText t={d.default} />. Bu her servise uymaz; portal her servis için geçmiş performansına göre
            gerçekçi bir hedef önerir, sahibi de buna göre karar verir.
          </p>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={count("breached")} label="servis hedefin altında" tone={count("breached") ? "crit" : "good"} />
        <Stat value={count("at_risk")} label="hedefte ama sınırda" tone={count("at_risk") ? "warn" : undefined} />
        <Stat value={count("ok")} label="hedefte" tone="good" />
        <Stat value={count("low_traffic")} label={`az trafik (${fmtNum(d.min_requests)} istekten az, değerlendirilmez)`} />
      </div>

      <Section title="Servisler" aside="Satıra tıklayınca route bazında detay ve hedef önerisi açılır">
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-[13.5px]">
            <thead><tr>
              <th className={th}>Servis</th><th className={th}>Durum</th><th className={th}>Hedef</th>
              <th className={thr}>Hızlı yanıt</th><th className={thr}>Hatasız</th><th className={th}>Ne demek</th><th className={th}>Son 7 gün</th>
            </tr></thead>
            <tbody className="divide-y divide-edge-soft">
              {d.services.map((s) => {
                const m = s.measured;
                const latBad = m && m.latency < s.target.latency_target;
                const avBad = m && m.availability < s.target.availability;
                return (
                  <tr key={s.service} className={`cursor-pointer hover:bg-edge-soft/50 ${s.status === "low_traffic" ? "opacity-65" : ""}`} onClick={() => nav(`/slo/${encodeURIComponent(s.service)}`)}>
                    <td className={td}>
                      <Link to={`/slo/${encodeURIComponent(s.service)}`} className="font-medium hover:text-accent" onClick={(e) => e.stopPropagation()}>{s.service}</Link>
                      <div className="text-[12px] text-ink-3">{fmtNum(m?.requests)} istek</div>
                    </td>
                    <td className={td}><Pill tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Pill></td>
                    <td className={td + " text-[12.5px] text-ink-2"}>
                      <div>%{(s.target.latency_target * 100).toFixed(0)} · {fmtNum(s.target.latency_ms)} ms</div>
                      <div className="mt-1"><SourcePill t={s.target} /></div>
                    </td>
                    <td className={tdn}><span className={latBad ? "font-semibold text-crit" : ""}>{m ? pct(m.latency) : "—"}</span></td>
                    <td className={tdn}><span className={avBad ? "font-semibold text-crit" : ""}>{m ? pct(m.availability, 2) : "—"}</span></td>
                    <td className={td + " max-w-[300px] text-ink-2"}>{s.status === "low_traffic" ? "Değerlendirmek için yeterli istek yok." : s.explain}</td>
                    <td className={td + " whitespace-nowrap text-[12.5px]"}><Trend v={s.trend} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      </Section>
    </>
  );
}
