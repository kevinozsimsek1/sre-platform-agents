import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import type { LogBreakdown, LogCost as LC, LogGroupCost } from "../lib/types";
import { fmtNum } from "../lib/format";
import { Bar, Empty, ErrorBox, Freshness, Info, Loading, PageHeader, Panel, Pill, Section, Stat, td, tdn, th, thr } from "../components/ui";

const usd = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const gb = (n: number) => `${n.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} GB`;

const FLAG: Record<string, { label: string; tone: "crit" | "warn" | "mute" }> = {
  retention_yok: { label: "saklama süresi yok", tone: "crit" },
  uzun_retention: { label: "uzun saklama", tone: "warn" },
  olu: { label: "yazılmıyor, yer tutuyor", tone: "warn" },
};

/** Log grubunun adından hangi kaynağa ait olduğunu çıkar: aksiyonu kim alacak sorusu. */
function source(name: string): string {
  if (name.startsWith("/aws/eks/")) return "EKS kontrol düzlemi";
  if (name.startsWith("/aws/containerinsights/")) return "Konteyner logları";
  if (name.startsWith("/aws/otlp/")) return "OpenTelemetry";
  if (name.startsWith("/aws/apigateway/")) return "API Gateway";
  if (name.startsWith("/aws/lambda/")) return "Lambda";
  if (name.startsWith("/aws/rds/")) return "RDS";
  if (name.includes("waf")) return "WAF";
  if (name.includes("msk") || name.includes("kafka")) return "Kafka / MSK";
  return "Diğer";
}

/** Tarama pencereleri. Logs Insights taranan bayt başına ücretli olduğu için
 *  seçim kullanıcıya bırakılır ve tahmini maliyet önceden gösterilir. */
const PENCERE: { label: string; minutes: number }[] = [
  { label: "15 dakika", minutes: 15 },
  { label: "1 saat", minutes: 60 },
  { label: "6 saat", minutes: 360 },
  { label: "24 saat", minutes: 1440 },
  { label: "7 gün", minutes: 10080 },
  { label: "30 gün (tamamı)", minutes: 43200 },
];
const AY_DK = 30 * 24 * 60;

/** Seçilen pencereyi tarayıp log grubunun içeriğini bileşene göre gösterir. */
function Breakdown({ group, ingest30d, scanRate }: { group: string; ingest30d: number; scanRate: number }) {
  const [minutes, setMinutes] = useState<number | null>(null);
  const q = useQuery<LogBreakdown>({
    queryKey: ["log-breakdown", group, minutes],
    queryFn: () => api(`/log-cost/breakdown?group=${encodeURIComponent(group)}&minutes=${minutes}`),
    enabled: minutes != null, staleTime: 30 * 60_000, retry: false,
  });

  // Tahmin: grubun 30 günlük gerçek hacminin bu pencereye düşen kısmı × tarama birim fiyatı
  const tahmin = (m: number) => ingest30d * (m / AY_DK) * scanRate;

  const seçim = (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] text-ink-2">
        Hangi aralık taransın? Logs Insights taranan bayt başına ücretli olduğu için seçim sana bırakılıyor;
        aşağıdaki tutarlar grubun gerçek hacminden hesaplanmış <b>tahmini</b> tarama maliyeti.
        Pencere uzadıkça sonuç kesinleşir, maliyet artar.
      </span>
      <div className="flex flex-wrap gap-1.5">
        {PENCERE.map((p) => {
          const t = tahmin(p.minutes);
          return (
            <button key={p.minutes} type="button" onClick={() => setMinutes(p.minutes)}
              className={`flex flex-col items-start rounded-md border px-2.5 py-1.5 text-left text-[12.5px] ${minutes === p.minutes ? "border-accent bg-accent-soft text-accent" : "border-edge text-ink-2 hover:border-accent hover:text-ink"}`}>
              <span className="font-medium">{p.label}</span>
              <span className="font-mono text-[11.5px] text-ink-3">
                ~{t < 0.01 ? "$0,01 altı" : usd(t)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  if (minutes == null) return seçim;
  if (q.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {seçim}
        <span className="inline-flex items-center gap-2 text-[13px] text-ink-2">
          <Loader2 size={14} className="animate-spin" />
          {PENCERE.find((p) => p.minutes === minutes)?.label} taranıyor
          {minutes >= 1440 && " — geniş pencerede bu bir iki dakika sürebilir"}
        </span>
      </div>
    );
  }
  if (q.error) return <div className="flex flex-col gap-2">{seçim}<span className="text-[13px] text-crit">{(q.error as Error).message}</span></div>;
  const d = q.data!;
  if (!d.available) return <div className="flex flex-col gap-2">{seçim}<span className="text-[13px] text-crit">{d.reason}</span></div>;
  const top = d.parts[0];
  const kat = Math.round(d.scale_factor);

  return (
    <div className="flex flex-col gap-3">
      {seçim}
      <span className="text-[12.5px] text-ink-2">
        {d.full
          ? <>Grubun <b className="font-semibold">tamamı (30 gün)</b> tarandı: {d.sample_mb} MB, {d.streams} akışta. Ölçek yok, rakamlar gerçek.</>
          : <>Son {d.minutes} dakikada {d.sample_mb} MB yazılmış, {d.streams} akışta. Aylığa ölçeklenince {d.projected_month_gb} GB.</>}
        {top && top.share > 0.5 && (
          <> <b className="font-semibold">Hacmin %{Math.round(top.share * 100)}'i tek bileşenden geliyor: <span className="font-mono">{top.name}</span>.</b></>
        )}
      </span>
      <table className="w-full text-[13px]">
        <thead><tr><th className={th}>Bileşen</th><th className={thr}>Pay</th><th className={thr}>Satır</th>
          <th className={thr}>Ölçülen MB</th><th className={thr}>GB / ay</th><th className={thr}>$ / ay</th></tr></thead>
        <tbody className="divide-y divide-edge-soft">
          {d.parts.map((p) => (
            <tr key={p.name}>
              <td className={td}><span className="font-mono text-[12.5px] break-all">{p.name}</span></td>
              <td className={tdn}>%{(p.share * 100).toFixed(1)}</td>
              <td className={tdn}>{fmtNum(p.lines)}</td>
              <td className={tdn}>{p.sample_mb}</td>
              <td className={tdn}>{p.month_gb}</td>
              <td className={tdn}><b>{usd(p.month_usd)}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-col gap-1 rounded-md bg-edge-soft/60 p-3 text-[12px] text-ink-2">
        <span className="font-semibold text-ink">Ölçek nasıl yapıldı</span>
        {d.full ? (
          <span>Tam 30 gün tarandığı için ölçek uygulanmadı: "GB / ay" sütunu doğrudan ölçülen hacimdir.</span>
        ) : (
          <>
            <code className="font-mono text-[12px] break-words">
              aylık GB = ölçülen bayt × ({fmtNum(AY_DK)} dakika ÷ {fmtNum(d.minutes)} dakika) = ölçülen bayt × {fmtNum(kat)}
            </code>
            <span>
              30 gün {fmtNum(AY_DK)} dakika; seçilen {fmtNum(d.minutes)} dakikalık pencere bunun {fmtNum(kat)}'de biri,
              o yüzden ölçüm {fmtNum(kat)} ile çarpılıyor. Örnek: {d.sample_mb} MB × {fmtNum(kat)} ÷ 1000 = {d.projected_month_gb} GB/ay.
            </span>
            <span className="text-ink-3">
              Varsayım: hacim gün içinde kabaca sabit. Tepe saatte taranırsa yüksek, gece taranırsa düşük çıkar.
              Pencereyi uzatmak bu belirsizliği azaltır. Karşılaştırma için grubun{" "}
              <span className="font-mono">IncomingBytes</span> metriğinden okunan 30 günlük gerçek hacmi
              tablonun üstündeki "Alım" sütununda duruyor.
            </span>
          </>
        )}
        <span className="text-ink-3">
          Bu taramanın gerçek maliyeti: {d.scan_gb} GB tarandı ={" "}
          {d.scan_usd < 0.01 ? `${usd(d.scan_usd)} (bir sentin altında)` : usd(d.scan_usd)}.
          Sonuç 30 dakika önbellekte tutulur, aynı pencereye tekrar basmak yeniden ücret çıkarmaz.
        </span>
      </div>
    </div>
  );
}

function Row({ g, max, scanRate }: { g: LogGroupCost; max: number; scanRate: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
    <tr>
      <td className={td}>
        <button type="button" onClick={() => setOpen((v) => !v)}
          className="flex items-start gap-1.5 text-left hover:text-accent">
          {open ? <ChevronDown size={13} className="mt-1 shrink-0" /> : <ChevronRight size={13} className="mt-1 shrink-0" />}
          <span className="font-mono text-[12.5px] break-all">{g.name}</span>
        </button>
        <span className="flex flex-wrap items-center gap-1.5 pt-1 pl-5">
          <span className="text-[12px] text-ink-3">{source(g.name)}</span>
          {g.flags.map((f) => <Pill key={f} tone={FLAG[f]?.tone ?? "mute"}>{FLAG[f]?.label ?? f}</Pill>)}
          {!open && <button type="button" onClick={() => setOpen(true)} className="text-[12px] font-medium text-accent">ne içeriyor?</button>}
        </span>
      </td>
      <td className={td}><div className="w-24"><Bar value={g.ingest_gb} max={max} tone={g.total_usd > max * 0.3 ? "crit" : "accent"} /></div></td>
      <td className={tdn}>{gb(g.ingest_gb)}</td>
      <td className={tdn}>{g.retention_days == null ? <span className="text-crit">sınırsız</span> : `${g.retention_days} gün`}</td>
      <td className={tdn}>{gb(g.stored_gb)}</td>
      <td className={tdn}><b>{usd(g.total_usd)}</b></td>
    </tr>
    {open && (
      <tr><td className={`${td} bg-canvas`} colSpan={6}><Breakdown group={g.name} ingest30d={g.ingest_gb} scanRate={scanRate} /></td></tr>
    )}
    </>
  );
}

export default function LogCost() {
  const qc = useQueryClient();
  const q = useQuery<LC>({ queryKey: ["log-cost"], queryFn: () => api("/log-cost"), staleTime: 600_000 });
  const [all, setAll] = useState(false);
  const [src, setSrc] = useState("");

  const groups = useMemo(() => (q.data?.available ? q.data.groups : []), [q.data]);
  const sources = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) m.set(source(g.name), (m.get(source(g.name)) ?? 0) + g.total_usd);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [groups]);

  if (q.isLoading) return <Loading label="Log grupları ve alım hacimleri okunuyor (ilk açılış ~40 sn)" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;

  if (!d.available) {
    return (
      <>
        <PageHeader eyebrow="Maliyet" title="Log maliyeti" />
        <Panel className="flex items-start gap-3 border-warn/40 p-4">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warn" />
          <div className="flex flex-col gap-1 text-[14px]">
            <b className="font-semibold">Log grupları okunamadı.</b>
            <p className="text-ink-2">{d.reason}</p>
            <p className="text-ink-2">
              Portala prod hesabında <span className="font-mono text-[12.5px]">logs:DescribeLogGroups</span> ve{" "}
              <span className="font-mono text-[12.5px]">cloudwatch:GetMetricData</span> okuma yetkisi gerekiyor.
            </p>
          </div>
        </Panel>
      </>
    );
  }

  const s = d.summary;
  const filtered = src ? groups.filter((g) => source(g.name) === src) : groups;
  const shown = all ? filtered : filtered.slice(0, 20);
  const max = Math.max(...groups.map((g) => g.ingest_gb), 1);

  return (
    <>
      <PageHeader eyebrow="Maliyet" title="Log maliyeti"
        actions={<Freshness at={d.fetched_at} busy={q.isFetching} onRefresh={() => qc.fetchQuery({ queryKey: ["log-cost"], queryFn: () => api("/log-cost?refresh=true") })} />}>
        <p className="max-w-[82ch] text-[15px] text-ink-2">
          CloudWatch faturasının en büyük kalemi log alımı. Burada hangi log grubunun ne kadar ürettiği,
          ne kadar süre saklandığı ve bunun kaça geldiği var — fazlalığı görüp kapatmak için.
        </p>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={usd(s.ingest_usd)} label={`log alımı (son ${d.window_days} gün)`} tone={s.ingest_usd > 50 ? "crit" : undefined}
          hint={<span className="inline-flex items-center gap-1.5">{gb(s.ingest_gb)}
            <Info title="Bu tutar nasıl hesaplandı">
              Her log grubuna yazılan bayt, CloudWatch'un kendi <span className="font-mono">AWS/Logs IncomingBytes</span>{" "}
              metriğinden okunuyor. GB başına birim fiyat uydurulmuyor: gerçek faturadaki tutar, faturalanan GB'ye bölünerek
              bulunuyor ({usd(d.rates.ingest_usd_per_gb)}/GB). Fatura bu hacmi iki satırda gösterir —
              uygulama logları <span className="font-mono">DataProcessing-Bytes</span>, AWS servislerinin kendi logları
              (EKS, WAF, VPC) <span className="font-mono">VendedLog-Bytes</span>.
            </Info></span>} />
        <Stat value={usd(s.storage_usd)} label="saklama maliyeti (aylık)"
          hint={<span className="inline-flex items-center gap-1.5">{gb(s.stored_gb)} saklı
            <Info title="Saklama maliyeti">
              Diskte duran log hacmi × faturadan türetilen GB-ay fiyatı ({usd(d.rates.storage_usd_per_gb_month)}).
              Alım maliyetinin yanında küçük kalır; asıl para loglar yazılırken ödeniyor.
            </Info></span>} />
        <Stat value={`%${Math.round(s.top10_share * 100)}`} label="ilk 10 grubun payı"
          hint={`${s.groups} log grubu var`} />
        <Stat value={fmtNum(s.no_retention)} label="saklama süresi tanımsız grup" tone={s.no_retention > 0 ? "warn" : undefined}
          hint={s.no_retention ? `${gb(s.no_retention_gb)} sonsuza kadar tutuluyor` : "hepsinde süre tanımlı"} />
      </div>

      {groups[0] && groups[0].total_usd > s.ingest_usd * 0.2 && (
        <Panel className="flex items-start gap-3 border-crit/40 p-4">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-crit" />
          <div className="flex flex-col gap-1.5 text-[14px]">
            <b className="font-semibold">
              Tek bir grup log maliyetinin %{Math.round((groups[0].total_usd / Math.max(s.ingest_usd + s.storage_usd, 0.01)) * 100)}'ini oluşturuyor
            </b>
            <p className="text-ink-2">
              <span className="font-mono text-[13px]">{groups[0].name}</span> — {d.window_days} günde {gb(groups[0].ingest_gb)},{" "}
              {usd(groups[0].total_usd)}. {source(groups[0].name) === "EKS kontrol düzlemi"
                ? "EKS kontrol düzlemi loglarıdır: api, audit, authenticator, controllerManager ve scheduler ayrı ayrı açılıp kapatılabilir. En hacimli olan genellikle audit'tir ve çoğu ekip onu sürekli açık tutmaya ihtiyaç duymaz."
                : "Bu grubun log seviyesi ve gerçekten gerekip gerekmediği gözden geçirilmeli."}
            </p>
            {groups[0].retention_days != null && groups[0].retention_days > 90 && (
              <p className="text-ink-2">
                Saklama süresi {groups[0].retention_days} gün. Bu kadar geriye bakılmıyorsa süreyi kısaltmak saklama maliyetini düşürür
                (alım maliyetini değiştirmez).
              </p>
            )}
          </div>
        </Panel>
      )}

      <Section title="Kaynağa göre" aside="Aksiyonu kimin alacağını belirler">
        <Panel className="flex flex-wrap gap-1.5 p-3">
          {[["", `Hepsi (${usd(s.ingest_usd + s.storage_usd)})`] as [string, string],
            ...sources.map(([n, v]) => [n, `${n} (${usd(v)})`] as [string, string])].map(([v, label]) => (
            <button key={v || "all"} type="button" onClick={() => { setSrc(v); setAll(false); }}
              className={`rounded-full border px-3 py-1 text-[13px] ${src === v ? "border-accent bg-accent-soft font-medium text-accent" : "border-edge text-ink-2 hover:text-ink"}`}>
              {label}
            </button>
          ))}
        </Panel>
      </Section>

      <Section title="Log grupları" aside={`${filtered.length} grup · en pahalıdan başlayarak`}>
        {filtered.length === 0 ? <Empty>Bu kaynakta log grubu yok.</Empty> : (
          <>
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-[13.5px]">
                <thead>
                  <tr>
                    <th className={th}>Log grubu</th>
                    <th className={th}>Alım</th>
                    <th className={thr}>{d.window_days} günde</th>
                    <th className={thr}>Saklama</th>
                    <th className={thr}>Diskte</th>
                    <th className={thr}>
                      <span className="inline-flex items-center gap-1.5">Aylık
                        <Info title="Grup başına tutar" align="right">
                          Alım (okunan GB × faturadan türetilen birim fiyat) + saklama (diskteki GB × GB-ay fiyatı).
                          Toplamları faturadaki log kalemlerine yakın çıkar; tam eşleşmemesi, faturanın takvim ayını,
                          buradaki ölçümün ise son {d.window_days} günü kapsamasından kaynaklanır.
                        </Info>
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-soft">
                  {shown.map((g) => <Row key={g.name} g={g} max={max} scanRate={d.rates.scan_usd_per_gb ?? 0.0063} />)}
                </tbody>
              </table>
            </Panel>
            {filtered.length > shown.length && (
              <button type="button" onClick={() => setAll(true)} className="w-fit text-[13px] font-medium text-accent">
                {filtered.length - shown.length} grup daha
              </button>
            )}
          </>
        )}
      </Section>

      <Section title="Ne yapılabilir">
        <Panel className="flex flex-col gap-2 p-4 text-[14px]">
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-ink-2">
            <li>
              <b className="font-medium text-ink">En hacimli gruptan başla.</b> İlk 10 grup toplam alımın
              %{Math.round(s.top10_share * 100)}'ini oluşturuyor; geri kalan {Math.max(s.groups - 10, 0)} grupla uğraşmak zaman kaybı.
            </li>
            <li>
              <b className="font-medium text-ink">EKS kontrol düzlemi loglarını tek tek değerlendir.</b> api, audit,
              authenticator, controllerManager ve scheduler ayrı ayrı kapatılabilir; audit genellikle en hacimli olandır.
            </li>
            <li>
              <b className="font-medium text-ink">Uygulama log seviyesini gözden geçir.</b> Prod'da debug/info seviyesinde
              yazan servisler alımın büyük kısmını üretir. Bu, alım maliyetini doğrudan düşüren tek müdahale.
            </li>
            <li>
              <b className="font-medium text-ink">Saklama süresi tanımsız grupları kapat.</b>
              {s.no_retention > 0 ? ` Şu an ${s.no_retention} grup sonsuza kadar tutuluyor.` : " Şu an hepsinde süre tanımlı."}
              {" "}Süre kısaltmak saklama maliyetini düşürür, alımı etkilemez.
            </li>
          </ol>
          <p className="text-[13px] text-ink-3">
            Saklama süresini kısaltmak ve log grubu silmek geri alınamaz. Portal bu işlemleri yapmaz, yalnızca gösterir.
          </p>
        </Panel>
      </Section>
    </>
  );
}
