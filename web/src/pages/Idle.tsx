import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import type { Idle as IdleData, IdleResource } from "../lib/types";
import { fmtDate } from "../lib/format";
import { Bar, Empty, ErrorBox, Freshness, Info, Loading, PageHeader, Panel, Pill, Section, Stat, td, tdn, th, thr, type Tone } from "../components/ui";

const usd = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Kaynak türü: ekranda ne olduğunu tek kelimeyle söyler. */
const KIND: Record<string, string> = {
  ec2: "Makine", ebs: "Disk", nat: "NAT gateway", eip: "Elastic IP", ipv4: "Genel IPv4",
  elb: "Yük dengeleyici", ecs: "Konteyner servisi", rds: "Veritabanı",
  snapshot: "Anlık görüntü", hata: "Okunamadı",
};

/** Bulgu etiketleri. Tonu "ne kadar acil" değil, "ne kadar kesin" anlatır:
 *  kırmızı = karşılığı olmadığı ölçülmüş, sarı = şüpheli, gri = bilgi. */
const FLAG: Record<string, { label: string; tone: Tone }> = {
  "bagli degil": { label: "bağlı değil", tone: "crit" },
  "durmus makinede": { label: "durmuş makinede", tone: "crit" },
  "istek yok": { label: "30 gündür istek almıyor", tone: "crit" },
  hedefsiz: { label: "hedefi yok", tone: "crit" },
  "vpc bos": { label: "VPC'de iş yükü yok", tone: "crit" },
  bosta: { label: "boşta", tone: "crit" },
  atil: { label: "atıl", tone: "warn" },
  "baglanti yok": { label: "bağlantı yok", tone: "warn" },
  "sabit ucret baskin": { label: "sabit ücret baskın", tone: "warn" },
  "0 task": { label: "0 task", tone: "warn" },
  "eski goruntu": { label: "6 aydan eski", tone: "warn" },
  "olcum yok": { label: "ölçüm yok", tone: "mute" },
  durduruldu: { label: "durduruldu", tone: "mute" },
  "bu ay calisti": { label: "bu ay bir süre açıktı", tone: "mute" },
  "bos cluster": { label: "boş cluster", tone: "mute" },
  okunamadi: { label: "okunamadı", tone: "mute" },
};

function Flag({ code }: { code: string }) {
  const f = FLAG[code] ?? { label: code, tone: "mute" as Tone };
  return <Pill tone={f.tone}>{f.label}</Pill>;
}

/** Bir kaynak satırı. Açılınca "ne içeriyor" dökümü gelir: kararı veren bilgi
 *  çoğu zaman kaynağın kendisinde değil içindekinde. */
function Row({ r, max }: { r: IdleResource; max: number }) {
  const [open, setOpen] = useState(false);
  const has = (r.contents?.length ?? 0) > 0 || !!r.note || !!r.basis;
  return (
    <>
      <tr>
        <td className={td}>
          <button type="button" onClick={() => has && setOpen((v) => !v)}
            className={`flex items-start gap-1.5 text-left ${has ? "hover:text-accent" : "cursor-default"}`}>
            {has && (open ? <ChevronDown size={13} className="mt-1 shrink-0" /> : <ChevronRight size={13} className="mt-1 shrink-0" />)}
            <span className="flex min-w-0 flex-col">
              <span className="font-medium break-words">{r.name}</span>
              <span className="font-mono text-[11.5px] text-ink-3 break-all">{r.id}</span>
            </span>
          </button>
          <span className="flex flex-wrap items-center gap-1.5 pt-1 pl-5">
            {r.flags.map((f) => <Flag key={f} code={f} />)}
            {has && !open && (
              <button type="button" onClick={() => setOpen(true)} className="text-[12px] font-medium text-accent">
                ne içeriyor?
              </button>
            )}
          </span>
        </td>
        <td className={td}>
          <span className="text-[12.5px]">{KIND[r.kind] ?? r.kind}</span>
          {r.detail && <div className="text-[11.5px] text-ink-3">{r.detail}</div>}
        </td>
        <td className={td}>
          <span className="font-mono text-[12px]">{r.region}</span>
          <div className="text-[11.5px] text-ink-3">{r.account}</div>
        </td>
        <td className={`${td} max-w-[320px]`}>
          <span className="text-[12.5px] text-ink-2">{r.evidence ?? "—"}</span>
        </td>
        <td className={td}><div className="w-16"><Bar value={r.usd_month} max={max} tone={r.usd_month > max * 0.3 ? "crit" : "accent"} /></div></td>
        <td className={tdn}>
          <span className="inline-flex items-center gap-1.5">
            <b>{r.usd_month > 0 ? usd(r.usd_month) : "—"}</b>
            {r.basis && (
              <Info title="Bu tutar nasıl hesaplandı" align="right">
                {r.basis}. Birim fiyat liste fiyatından değil, bu bölgenin gerçek faturasından
                türetiliyor: ilgili kalemin tutarı ÷ miktarı. Böylece rakam AWS'nin o ay fiilen
                uyguladığı orana dayanır.
              </Info>
            )}
          </span>
        </td>
      </tr>
      {open && (
        <tr>
          <td className={`${td} bg-canvas`} colSpan={6}>
            <div className="flex flex-col gap-2">
              {r.note && <p className="text-[13px] text-ink-2">{r.note}</p>}
              {(r.contents?.length ?? 0) > 0 && (
                <dl className="grid gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-[minmax(0,13rem)_1fr]">
                  {r.contents!.map((c, i) => (
                    <div key={i} className="contents">
                      <dt className="text-ink-3">{c.label}</dt>
                      <dd className="font-mono text-[12px] break-words">{c.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {r.since && <p className="text-[12px] text-ink-3">Oluşturulma: {fmtDate(Date.parse(r.since))}</p>}
              {r.basis && <p className="text-[12px] text-ink-3">Tutarın dayanağı: {r.basis}.</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function Idle() {
  const qc = useQueryClient();
  const q = useQuery<IdleData>({ queryKey: ["idle"], queryFn: () => api("/idle"), staleTime: 3600_000 });
  const [acct, setAcct] = useState("");
  const [region, setRegion] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(true);

  const all = useMemo<IdleResource[]>(
    () => (q.data?.available ? q.data.accounts.flatMap((a) => a.resources) : []),
    [q.data],
  );
  const shown = useMemo(() => {
    let rows = all;
    if (acct) rows = rows.filter((r) => r.account === acct);
    if (region) rows = rows.filter((r) => r.region === region);
    if (onlyFlagged) rows = rows.filter((r) => r.flags.length > 0);
    return [...rows].sort((a, b) => b.usd_month - a.usd_month);
  }, [all, acct, region, onlyFlagged]);

  if (q.isLoading) return <Loading label="Hesaplar ve bölgeler taranıyor (ilk açılış ~1 dk)" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;

  if (!d.available) {
    return (
      <>
        <PageHeader eyebrow="Maliyet" title="Atıl kaynaklar" />
        <Panel className="flex items-start gap-3 border-warn/40 p-4">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warn" />
          <div className="flex flex-col gap-1 text-[14px]">
            <b className="font-semibold">Tarama yapılamadı.</b>
            <p className="text-ink-2">{d.reason}</p>
            <p className="text-ink-2">
              Portala <span className="font-mono text-[12.5px]">ce:GetCostAndUsage</span>,{" "}
              <span className="font-mono text-[12.5px]">ec2:Describe*</span>,{" "}
              <span className="font-mono text-[12.5px]">elasticloadbalancing:Describe*</span>,{" "}
              <span className="font-mono text-[12.5px]">ecs:Describe*</span>,{" "}
              <span className="font-mono text-[12.5px]">rds:DescribeDBInstances</span> ve{" "}
              <span className="font-mono text-[12.5px]">cloudwatch:GetMetricData</span> okuma yetkisi gerekiyor.
              Birden çok hesabı taramak için <span className="font-mono text-[12.5px]">IDLE_AWS_ACCOUNTS</span>{" "}
              değişkenine <span className="font-mono text-[12.5px]">etiket=profil</span> çiftleri verilir.
            </p>
          </div>
        </Panel>
      </>
    );
  }

  const s = d.summary;
  const max = Math.max(...all.map((r) => r.usd_month), 1);
  const regions = [...new Set(all.map((r) => r.region))].sort();
  const top = shown[0];

  return (
    <>
      <PageHeader eyebrow="Maliyet" title="Atıl kaynaklar"
        actions={<Freshness at={d.fetched_at} busy={q.isFetching}
          onRefresh={() => qc.fetchQuery({ queryKey: ["idle"], queryFn: () => api("/idle?refresh=true") })} />}>
        <p className="max-w-[82ch] text-[15px] text-ink-2">
          Buradaki soru "fatura kaç" değil, <b className="font-semibold">"bu şey kullanılıyor mu"</b>.
          İsraf ana bölgede değil, bir kez kurulup unutulmuş hesap-bölge çiftinde birikir; o yüzden tarama
          bütün hesapları ve bütün bölgeleri kapsar. Her satırda kararı veren ölçüm yazılı — ölçüm yoksa
          "bilinmiyor" denir, tahmin edilmez.
        </p>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={s.flagged} label="karşılığı sorgulanan kaynak" tone={s.flagged ? "warn" : "good"}
          hint={<span className="inline-flex items-center gap-1.5">{usd(s.flagged_usd)} aylık
            <Info title="Bu rakam ne anlatıyor">
              İşaretlenen kaynakların aylık tutarlarının toplamı. Tamamı kazanç değil: bazıları
              gerçekten gerekli olabilir. "Bakılması gereken para" olarak okunmalı, "kesilecek para"
              olarak değil — her satırın kendi kanıtı var.
            </Info></span>} />
        <Stat value={usd(s.usd_last_full)} label={`taranan toplam harcama`}
          hint={`${s.accounts} hesap · ${s.regions} bölge`} />
        <Stat value={usd(s.away_usd)} label="ana bölge dışındaki harcama" tone={s.away_usd > 50 ? "warn" : undefined}
          hint={<span className="inline-flex items-center gap-1.5">{s.away_regions} bölge
            <Info title="Neden ayrı gösteriliyor">
              Ekibin her gün baktığı bölge ana bölge. Onun dışındaki her bölge, birinin bir kez kurup
              unuttuğu bir şey olma ihtimalini taşır. Burada para varsa önce oraya bakılır.
            </Info></span>} />
        <Stat value={top ? usd(top.usd_month) : "—"} label="en pahalı tek bulgu"
          hint={top ? `${KIND[top.kind] ?? top.kind} · ${top.region}` : "bulgu yok"} />
      </div>

      {s.away.length > 0 && (
        <Panel className="flex items-start gap-3 border-warn/40 p-4">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warn" />
          <div className="flex min-w-0 flex-col gap-1.5 text-[14px]">
            <b className="font-semibold">Ana bölge dışında ayda {usd(s.away_usd)} harcanıyor</b>
            <p className="text-ink-2">
              {s.away.slice(0, 4).map((a, i) => (
                <span key={`${a.account}/${a.region}`}>
                  {i > 0 && " · "}
                  <span className="font-mono text-[13px]">{a.region}</span> ({a.account}) {usd(a.usd)}
                </span>
              ))}
              {s.away.length > 4 && ` · ve ${s.away.length - 4} bölge daha`}
            </p>
            <p className="text-ink-2">
              Bu bölgeler kimsenin dashboard'unda yok. Aşağıdaki tabloda her birinin içindeki kaynaklar
              ve kullanılıp kullanılmadıkları duruyor.
            </p>
          </div>
        </Panel>
      )}

      <Section title="Hesap ve bölge" aside="Harcamanın nerede olduğu">
        {d.accounts.map((a) => (
          <Panel key={a.label} className="overflow-x-auto">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-edge px-4 py-2.5">
              <span className="text-[14px] font-semibold">
                {a.label}
                {a.account && <span className="pl-2 font-mono text-[12px] font-normal text-ink-3">{a.account}</span>}
              </span>
              <span className="text-[12.5px] text-ink-3">
                {a.month} toplamı {usd(a.usd_last_full)} · ana bölge <span className="font-mono">{a.home_region}</span>
              </span>
            </div>
            <table className="w-full min-w-[640px] text-[13.5px]">
              <thead>
                <tr>
                  <th className={th}>Bölge</th>
                  <th className={thr}>{a.month}</th>
                  <th className={thr}>{a.current_month} (sürüyor)</th>
                  <th className={th}>En büyük kalemler</th>
                  <th className={thr}>Tarandı</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-soft">
                {a.regions.filter((r) => r.usd_last_full >= 0.01).map((r) => (
                  <tr key={r.region}>
                    <td className={td}>
                      <span className="font-mono text-[12.5px]">{r.region}</span>
                      {r.region !== a.home_region && <div className="text-[11.5px] text-warn">ana bölge değil</div>}
                    </td>
                    <td className={tdn}><b>{usd(r.usd_last_full)}</b></td>
                    <td className={tdn}>{usd(r.usd_current)}</td>
                    <td className={`${td} text-[12px] text-ink-2`}>
                      {r.items.slice(0, 3).map((i) => (
                        <div key={i.usage_type} className="truncate">
                          <span className="font-mono text-[11.5px]">{i.usage_type}</span> {usd(i.cost)}
                        </div>
                      ))}
                    </td>
                    <td className={tdn}>
                      {r.swept ? <Pill tone="good">evet</Pill> : <span className="text-ink-3">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {a.other_regions_usd > 0 && (
              <p className="px-4 py-2 text-[12px] text-ink-3">
                Listelenmeyen diğer bölgeler toplam {usd(a.other_regions_usd)}.
              </p>
            )}
          </Panel>
        ))}
      </Section>

      <Section title="Kaynaklar" aside={`${shown.length} satır · en pahalıdan başlayarak`}>
        <Panel className="flex flex-wrap items-center gap-2 p-3">
          <select id="idle-acct" value={acct} onChange={(e) => setAcct(e.target.value)}
            className="rounded-md border border-edge bg-canvas px-2.5 py-1.5 text-sm">
            <option value="">Tüm hesaplar</option>
            {d.accounts.map((a) => <option key={a.label} value={a.label}>{a.label}</option>)}
          </select>
          <select id="idle-region" value={region} onChange={(e) => setRegion(e.target.value)}
            className="rounded-md border border-edge bg-canvas px-2.5 py-1.5 text-sm">
            <option value="">Tüm bölgeler</option>
            {regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input id="idle-flagged" type="checkbox" checked={onlyFlagged}
              onChange={(e) => setOnlyFlagged(e.target.checked)} />
            Yalnızca karşılığı sorgulananlar
          </label>
        </Panel>

        {shown.length === 0 ? <Empty>Bu filtreyle kaynak yok.</Empty> : (
          <Panel className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-[13.5px]">
              <thead>
                <tr>
                  <th className={th}>Kaynak</th>
                  <th className={th}>Tür</th>
                  <th className={th}>Yer</th>
                  <th className={th}>
                    <span className="inline-flex items-center gap-1.5">Kullanılıyor mu
                      <Info title="Bu sütun nereden geliyor">
                        Her tür için kararı veren metrik son {d.window_days} gün için CloudWatch'tan
                        okunuyor: makinede ortalama işlemci ve ağ çıkışı, yük dengeleyicide istek sayısı,
                        NAT'ta dışarıya geçen bayt, veritabanında bağlantı sayısı. Metrik hiç yoksa
                        "ölçüm yok" yazılır; kullanılmadığı varsayılmaz.
                      </Info>
                    </span>
                  </th>
                  <th className={th}>Pay</th>
                  <th className={thr}>Aylık</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-soft">
                {shown.map((r) => <Row key={`${r.account}/${r.region}/${r.kind}/${r.id}`} r={r} max={max} />)}
              </tbody>
            </table>
          </Panel>
        )}
      </Section>

      <Section title="Nasıl okunur">
        <Panel className="flex flex-col gap-2 p-4 text-[14px]">
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-ink-2">
            <li>
              <b className="font-medium text-ink">Kırmızı etiketler ölçülmüş olanlar.</b> "Bağlı değil",
              "30 gündür istek almıyor", "hedefi yok" — bunlar yorum değil, metriğin ya da envanterin
              doğrudan söylediği şey.
            </li>
            <li>
              <b className="font-medium text-ink">Sarı etiketler şüphe.</b> "Atıl" bir makine haftada bir
              çalışan bir iş olabilir; silmeden önce sahibini bulmak gerekir.
            </li>
            <li>
              <b className="font-medium text-ink">"Ne içeriyor" dökümünü aç.</b> Bir yük dengeleyici
              "active" görünür ama hedef grubu boşsa kimseye hizmet etmiyordur. NAT'ı kaldırıp
              kaldıramayacağın, VPC'sinde internete çıkması gereken iş yükü kalıp kalmadığına bağlı.
            </li>
            <li>
              <b className="font-medium text-ink">Sabit ücretle trafik ücretini ayır.</b> NAT gateway'de
              para çoğunlukla "var olma" ücretinden gelir; trafiği azaltmak o kalemi düşürmez, yalnızca
              NAT'ı kaldırmak düşürür.
            </li>
          </ol>
          <p className="text-[13px] text-ink-3">
            Tarama hesap başına tek Cost Explorer isteğidir ($0,01); geri kalan her çağrı ücretsiz
            describe'dır. Günde bir yenilenir. Portal hiçbir kaynağı silmez ya da değiştirmez, yalnızca gösterir.
          </p>
        </Panel>
      </Section>
    </>
  );
}
