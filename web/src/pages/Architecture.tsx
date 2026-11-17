import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pause, Play } from "lucide-react";
import { api } from "../lib/api";
import { fmtNum } from "../lib/format";
import { Panel, PageHeader, Section } from "../components/ui";

/** Sinyal türleri: diyagramdaki her ok bunlardan biri. */
type Kind = "metric" | "log" | "alert" | "work";

const FLOW: Record<Kind, string> = { metric: "stroke-accent", log: "stroke-warn", alert: "stroke-crit", work: "stroke-good" };
const HEAD: Record<Kind, string> = { metric: "fill-accent", log: "fill-warn", alert: "fill-crit", work: "fill-good" };
const LEGEND: { kind: Kind; label: string }[] = [
  { kind: "metric", label: "Ölçüm" },
  { kind: "log", label: "Log" },
  { kind: "alert", label: "Alert bildirimi" },
  { kind: "work", label: "İş akışı" },
];

type Node = { id: string; col: number; y: number; title: string; sub: string; role: string; body: string; facts: [string, string][] };
type Edge = { from: string; to: string; kind: Kind; label?: string };

const W = 168, H = 62;
const COL = [95, 315, 535, 760, 985];
const HEADS = ["Üretim", "Telemetri", "Depolama", "Değerlendirme", "Ekip"];

const EDGES: Edge[] = [
  { from: "prod", to: "otel", kind: "metric", label: "ölçüm" },
  { from: "prod", to: "flb", kind: "log" },
  { from: "eks", to: "ksm", kind: "metric" },
  { from: "otel", to: "prom", kind: "metric" },
  { from: "otel", to: "tempo", kind: "metric", label: "iz" },
  { from: "ksm", to: "prom", kind: "metric" },
  { from: "flb", to: "cw", kind: "log" },
  { from: "prom", to: "graf", kind: "metric" },
  { from: "tempo", to: "graf", kind: "metric" },
  { from: "cw", to: "agent", kind: "log", label: "sorgu" },
  { from: "graf", to: "chat", kind: "alert", label: "alert" },
  { from: "graf", to: "portal", kind: "metric", label: "salt okuma" },
  { from: "agent", to: "portal", kind: "work", label: "soru / cevap" },
  { from: "portal", to: "team", kind: "work", label: "atama" },
  { from: "chat", to: "team", kind: "alert" },
];

/** Diyagramın kutuları. Sayıların canlı olanları /config ve /alerts/summary'den gelir. */
function buildNodes(rules: number, paused: number, days: number, team: number): Node[] {
  return [
    { id: "prod", col: 0, y: 170, title: "Prod servisleri", sub: "7 namespace", role: "üretim",
      body: "plt (plt-comm-* mikroservisleri), pos-backend, online-store-backend, admin-panel-backend, e-commerce, data-process ve nebim-admin-control-panel. .NET servisleri kendi ölçümlerini OpenTelemetry ile üretiyor.",
      facts: [["Namespace", "7"], ["Dil", ".NET"], ["OTel SDK", "1.15 – 1.17"]] },
    { id: "eks", col: 0, y: 330, title: "EKS cluster", sub: "era-eks-prod", role: "üretim",
      body: "Servislerin üzerinde koştuğu Kubernetes. Pod'ları açan ReplicaSet değiştiği an bir değişiklik sayılır: image farklıysa yeni sürüm, aynıysa yeniden başlatma. Her gün 07:20'de 27 deployment zamanlı olarak yeniden başlıyor.",
      facts: [["Bölge", "eu-central-1"], ["Zamanlı restart", "07:20"], ["Etkilenen", "27 deployment"]] },
    { id: "otel", col: 1, y: 100, title: "OTel SDK → OTLP", sub: "localhost:4317", role: "telemetri",
      body: "Her servis kendi içindeki toplayıcıya yazıyor. Gelen istekler http_server_request_duration_seconds, dış çağrılar http_client_request_duration_seconds. Dikkat: dış çağrı trafiğinin %76'sı telemetrinin kendi gönderimi, bu yüzden global ortalamalar yanıltıcı olabiliyor.",
      facts: [["Port", "4317"], ["Telemetri payı", "%76"], ["Telemetri gecikmesi", "5 ms"]] },
    { id: "ksm", col: 1, y: 250, title: "kube-state-metrics", sub: "node-exporter · cAdvisor", role: "telemetri",
      body: "Cluster'ın kendi durumu: pod ve ReplicaSet kayıtları, node doluluğu, PVC kullanımı, sertifika süreleri, GPU ölçümü. Portaldaki Cluster durumu sayfası tamamen buradan besleniyor.",
      facts: [["Exporter", "5"], ["Besler", "Cluster sayfası"], ["Sertifika uyarısı", "< 21 gün"]] },
    { id: "flb", col: 1, y: 400, title: "Fluent Bit", sub: "konteyner logları", role: "telemetri",
      body: "Her node üzerinde çalışıp konteyner loglarını CloudWatch'a taşıyor. Log grupları servis adıyla eşleştiği için portal bir servisten doğrudan log grubuna link verebiliyor.",
      facts: [["Çalışma", "her node"], ["Hedef", "CloudWatch"]] },
    { id: "prom", col: 2, y: 100, title: "Prometheus", sub: "32 gün saklama", role: "depolama",
      body: "Bütün ölçümlerin durduğu yer. Saklama süresi ölçülerek bulundu: 32 gün öncesinde veri var, 33 gün öncesinde yok. Portal penceresi bilerek bunun altında tutuluyor ki sınıra dayanıp yarım veri göstermesin.",
      facts: [["Saklama", "32 gün"], ["Portal penceresi", `${days} gün`], ["Değişiklik kaynağı", "pod kayıtları"]] },
    { id: "tempo", col: 2, y: 250, title: "Tempo", sub: "dağıtık izler", role: "depolama",
      body: "Tek bir isteğin servisler arasında izlediği yol. Portal bir alert'i incelerken o zaman aralığındaki ilgili izlere link veriyor; böylece ölçümden ize kadar takip edilebiliyor.",
      facts: [["Kullanım", "alert bağlamı"], ["Erişim", "Grafana üzerinden"]] },
    { id: "cw", col: 2, y: 400, title: "CloudWatch Logs", sub: "Logs Insights", role: "depolama",
      body: "Log grupları /aws/containerinsights/era-eks-prod/ altında. Portal hazır Logs Insights sorguları üretip AWS konsoluna link veriyor; aynı sorguları CloudWatch agent'ı kendisi de çalıştırabiliyor.",
      facts: [["Önek", "/aws/containerinsights/"], ["Sorgu", "Logs Insights"]] },
    { id: "graf", col: 3, y: 140, title: "Grafana", sub: `${fmtNum(rules)} alert kuralı`, role: "değerlendirme",
      body: "Kuralların değerlendirildiği yer; org 3 prod demek. Alert geçmişi annotation olarak burada durduğu için portaldaki olay listesi de buradan çıkıyor. Portal Grafana'ya yalnızca okuma isteği atıyor, hiçbir kuralı ya da dashboard'u değiştiremiyor.",
      facts: [["Prod org", "3"], ["Alert kuralı", fmtNum(rules)], ["Duraklatılmış", fmtNum(paused)], ["Portal erişimi", "salt okuma"]] },
    { id: "agent", col: 3, y: 400, title: "LLM agent'ları", sub: "gpt-oss-20b", role: "değerlendirme",
      body: "CloudWatch ve EKS agent'ları MCP üzerinden gerçek araç çağırıyor: log sorgusu çalıştırıyor, metrik çekiyor. Arkalarında era-llm-cluster-group-kk node grubunda tek bir g6.xlarge GPU var; bu makine gece kapatılıp sabah açılıyor.",
      facts: [["Model", "gpt-oss-20b"], ["Makine", "1 × g6.xlarge"], ["Arayüz", "MCP"]] },
    { id: "chat", col: 4, y: 90, title: "Google Chat", sub: "alert bildirimi", role: "ekip",
      body: "Alert'ler şu an yalnızca buraya düşüyor. Bağlı bir nöbet aracı olmadığı için kimin ne zaman cevapladığı ölçülemiyor; Maliyet ve değer sayfasındaki nöbet tablosunun eksik kalan tarafı tam olarak burası.",
      facts: [["Kanal", "Google Chat"], ["Yanıt süresi", "ölçülemiyor"]] },
    { id: "portal", col: 4, y: 255, title: "SRE Portal", sub: "tek ekran", role: "değerlendirme",
      body: "Dağınık duran bu kaynakları tek yerde toplayan ekran: hangi alert'in bozuk olduğu, olaylar ve kime atandığı, cluster'ın durumu, prod'da ne değiştiği, servislerin hedefi tutup tutmadığı ve nöbetin maliyeti. Grafana'ya yalnızca okuma isteği atıyor, hiçbir şeyi değiştiremiyor. Atamalar ve hedefler kalıcı saklanıyor; cluster üzerindeki tek yetkisi o iki kaydı okuyup güncellemek.",
      facts: [] },
    { id: "team", col: 4, y: 420, title: "SRE ekibi", sub: `${team} kişi`, role: "ekip",
      body: "Olaylar portalden kişilere atanıyor, iş bitince Tamamlandı işaretleniyor ve her değişiklik denetim kaydına düşüyor. Atamalar 90 gün saklanıyor.",
      facts: [["Kişi", String(team)], ["Atama saklama", "90 gün"], ["Denetim kaydı", "her değişiklik"]] },
  ];
}

type Anchor = "start" | "middle" | "end";

function edgePath(a: Node, b: Node): { d: string; lx: number; ly: number; anchor: Anchor } {
  const x1 = COL[a.col], y1 = a.y, x2 = COL[b.col], y2 = b.y;
  if (a.id === "chat" && b.id === "team") {
    return { d: `M ${x1 + W / 2} ${y1} C 1132 ${y1 + 20}, 1132 ${y2 - 20}, ${x2 + W / 2} ${y2}`, lx: 1104, ly: (y1 + y2) / 2, anchor: "end" };
  }
  if (x1 === x2) {
    return { d: `M ${x1} ${y1 + H / 2} L ${x2} ${y2 - H / 2}`, lx: x1 + 10, ly: (y1 + y2) / 2 + 4, anchor: "start" };
  }
  const sx = x1 + W / 2, ex = x2 - W / 2, mx = (sx + ex) / 2;
  return { d: `M ${sx} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${ex} ${y2}`, lx: mx, ly: (y1 + y2) / 2 - 7, anchor: "middle" };
}

export default function Architecture() {
  const cfg = useQuery<{ team: string[] }>({ queryKey: ["config"], queryFn: () => api("/config"), staleTime: 600_000 });
  const sum = useQuery<{ totals: { rules: number; paused: number }; window: { days: number } }>({
    queryKey: ["alerts-summary"], queryFn: () => api("/alerts/summary"),
  });
  const [sel, setSel] = useState("portal");
  const [hover, setHover] = useState<string | null>(null);
  const [still, setStill] = useState(false);

  const nodes = useMemo(
    () => buildNodes(sum.data?.totals.rules ?? 139, sum.data?.totals.paused ?? 27, sum.data?.window.days ?? 30, cfg.data?.team.length ?? 5),
    [sum.data, cfg.data],
  );
  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<string, Node>, [nodes]);
  const active = hover ?? null;
  const detail = byId[sel] ?? nodes[0];
  const near = (id: string) =>
    !active || id === active || EDGES.some((e) => (e.from === active && e.to === id) || (e.to === active && e.from === id));

  return (
    <>
      <PageHeader eyebrow="Mimari" title="Sinyal haritası"
        actions={
          <button type="button" onClick={() => setStill((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[13px] text-ink-2 hover:text-ink">
            {still ? <Play size={13} /> : <Pause size={13} />} {still ? "Akışı başlat" : "Akışı durdur"}
          </button>
        }>
        <p className="max-w-[80ch] text-[15px] text-ink-2">
          Prod'da bir şey olduğunda haberin sana hangi yoldan ulaştığı. Soldaki servislerden çıkan ölçümler ve loglar,
          sağdaki nöbetçiye varana kadar hangi duraklardan geçiyor ve her durakta ne kadar süre saklanıyor.
          Bir kutuya tıkla, altında ayrıntısı açılsın.
        </p>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {LEGEND.map((l) => (
          <span key={l.kind} className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
            <svg width="24" height="8" aria-hidden className="shrink-0">
              <line x1="1" y1="4" x2="23" y2="4" strokeWidth="2.5" strokeDasharray="4 4" strokeLinecap="round" className={FLOW[l.kind]} />
            </svg>
            {l.label}
          </span>
        ))}
      </div>

      <Panel className={`overflow-x-auto ${still ? "signal-still" : ""}`}>
        <svg viewBox="0 0 1160 486" className="block h-auto w-full min-w-[1000px]" role="img"
          aria-label="Prod telemetrisinin servislerden SRE ekibine akışını gösteren diyagram">
          <defs>
            <pattern id="sig-dots" width="22" height="22" patternUnits="userSpaceOnUse">
              <circle cx="1.5" cy="1.5" r="1" className="fill-edge" />
            </pattern>
            {LEGEND.map((l) => (
              <marker key={l.kind} id={`sig-${l.kind}`} viewBox="0 0 10 10" refX="8.5" refY="5"
                markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 z" className={HEAD[l.kind]} />
              </marker>
            ))}
          </defs>

          <rect x="0" y="0" width="1160" height="486" fill="url(#sig-dots)" opacity="0.45" />

          {HEADS.map((h, i) => (
            <g key={h}>
              {i % 2 === 0 && <rect x={COL[i] - 102} y="44" width="204" height="424" rx="12" className="fill-edge-soft" opacity="0.5" />}
              <rect x={COL[i] - (h.length * 7 + 24) / 2} y="12" width={h.length * 7 + 24} height="21" rx="10.5" className="fill-edge-soft" />
              <text x={COL[i]} y={27} textAnchor="middle"
                className="fill-ink-3 font-mono text-[10.5px] tracking-[0.13em] uppercase">{h}</text>
            </g>
          ))}

          {EDGES.map((e) => {
            const a = byId[e.from], b = byId[e.to];
            if (!a || !b) return null;
            const { d, lx, ly, anchor } = edgePath(a, b);
            const on = active === e.from || active === e.to;
            const dim = active && !on;
            return (
              <g key={`${e.from}-${e.to}`} className={dim ? "opacity-15" : ""}>
                <path d={d} fill="none" strokeWidth="1.4" className="stroke-edge" />
                <path d={d} fill="none" markerEnd={`url(#sig-${e.kind})`}
                  strokeWidth={on ? 3.2 : 2.2} className={`signal-flow ${FLOW[e.kind]} ${on ? "signal-fast" : ""}`} />
                {e.label && (
                  <text x={lx} y={ly} textAnchor={anchor} className="fill-ink-3 font-mono text-[10.5px]">{e.label}</text>
                )}
              </g>
            );
          })}

          {nodes.map((n) => {
            const x = COL[n.col], chosen = n.id === sel;
            return (
              <g key={n.id} tabIndex={0} role="button" aria-label={`${n.title}, ${n.sub}`}
                className={`cursor-pointer outline-none ${near(n.id) ? "" : "opacity-30"}`}
                onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
                onFocus={() => { setHover(n.id); setSel(n.id); }} onBlur={() => setHover(null)}
                onClick={() => setSel(n.id)}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSel(n.id); } }}>
                {chosen && (
                  <rect x={x - W / 2 - 5} y={n.y - H / 2 - 5} width={W + 10} height={H + 10} rx="15"
                    fill="none" strokeWidth="1.5" className="stroke-accent" opacity="0.35" />
                )}
                <rect x={x - W / 2} y={n.y - H / 2} width={W} height={H} rx="10" strokeWidth={chosen ? 2.2 : 1.2}
                  className={chosen ? "fill-accent-soft stroke-accent" : "fill-panel stroke-edge"} />
                <text x={x} y={n.y - 4} textAnchor="middle" className="fill-ink text-[14px] font-semibold">{n.title}</text>
                <text x={x} y={n.y + 15} textAnchor="middle" className="fill-ink-3 font-mono text-[11px]">{n.sub}</text>
              </g>
            );
          })}
        </svg>
      </Panel>

      <Section title={detail.title} aside={<span className="font-mono text-[11px] tracking-wider text-ink-3 uppercase">{detail.role}</span>}>
        <Panel className={`grid gap-5 p-5 ${detail.facts.length ? "lg:grid-cols-[1.5fr_1fr] lg:gap-8" : ""}`}>
          <p className="max-w-[62ch] text-[14.5px] text-ink-2">{detail.body}</p>
          {detail.facts.length > 0 && (
            <dl className="flex min-w-0 flex-col gap-2 self-start">
              {detail.facts.map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-4 border-b border-edge-soft pb-1.5 last:border-0">
                  <dt className="text-[12.5px] text-ink-3">{k}</dt>
                  <dd className="text-right font-mono text-[13px] font-medium tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </Panel>
      </Section>

      <p className="text-[12.5px] text-ink-3">
        Yapısal bilgiler cluster ve Grafana üzerinde doğrulandı; alert kuralı sayısı ile pencere canlı olarak portalden geliyor.
        Prometheus saklama süresi ölçülerek bulundu: 32 günde veri var, 33'te yok.
      </p>
    </>
  );
}
