import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import type { Changes as C } from "../lib/types";
import { fmtDate, fmtNum } from "../lib/format";
import ChangeBatchCard from "../components/ChangeBatchCard";
import { Empty, ErrorBox, Freshness, Loading, PageHeader, Panel, Section, Stat } from "../components/ui";

export default function Changes() {
  const qc = useQueryClient();
  const q = useQuery<C>({ queryKey: ["changes"], queryFn: () => api("/changes") });
  const [filter, setFilter] = useState<"all" | "release" | "incident">("all");
  const [hideScheduled, setHideScheduled] = useState(true);

  const batches = useMemo(() => {
    if (!q.data) return [];
    const sched = new Set(q.data.schedules.map((s) => s.time));
    return q.data.batches.filter((b) => {
      const d = new Date(b.start);
      const hm = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit" }).format(d);
      const slot = hm.slice(0, 4) + "0";
      const scheduled = b.releases === 0 && sched.has(slot);
      if (hideScheduled && scheduled && !(b.incidents_after?.length)) return false;
      if (filter === "release") return b.releases + (b.rollbacks ?? 0) + (b.new ?? 0) > 0;
      if (filter === "incident") return (b.incidents_after?.length ?? 0) > 0;
      return true;
    });
  }, [q.data, filter, hideScheduled]);

  if (q.isLoading) return <Loading label="Prod'daki değişiklikler toplanıyor" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const c = d.correlation;

  // Günlere göre grupla
  const days: [string, typeof batches][] = [];
  for (const b of batches) {
    const key = fmtDate(b.start);
    const last = days[days.length - 1];
    if (last && last[0] === key) last[1].push(b); else days.push([key, [b]]);
  }

  return (
    <>
      <PageHeader eyebrow="Değişiklik takibi" title="Prod'da ne değişti"
        actions={<Freshness at={d.fetched_at} busy={q.isFetching} onRefresh={() => qc.fetchQuery({ queryKey: ["changes"], queryFn: () => api("/changes?refresh=true") })} />}>
        <p className="max-w-[78ch] text-[15px] text-ink-2">
          Prod cluster'ındaki yeni sürümler, geri almalar ve yeniden başlatmalar; her birinden sonraki bir saat içinde başlayan olaylar. Bir olay olduğunda ilk sorulan soru
          "son ne değişti?" olduğu için olay sayfalarında da bu bilgi görünür.
        </p>
        <p className="max-w-[78ch] text-[13.5px] text-ink-3">
          Kaynak: Prometheus'taki pod kayıtları (kube-state-metrics), son {d.window_days} gün. Bir deployment'ın pod'larını açan ReplicaSet değiştiği an bir değişikliktir:
          image farklıysa yeni sürüm, aynıysa yeniden başlatma, daha eski bir ReplicaSet'e dönüldüyse geri alma. Ölçekleme değişiklik sayılmaz.
          "En az … beri" yazan yerlerde sürümün başlangıcı {d.window_days} günden eski olduğu için tam tarih bilinmiyor; gösterilen, görünen en eski kayıttır.
        </p>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={fmtNum(d.stats.releases)} label="yeni sürüm (image değişti)"
          hint={[d.stats.rollbacks ? `${d.stats.rollbacks} geri alma` : "", d.stats.new ? `${d.stats.new} yeni deployment` : ""].filter(Boolean).join(" · ") || undefined} />
        <Stat value={fmtNum(d.stats.restarts)} label="yeniden başlatma / ayar değişikliği" />
        <Stat value={fmtNum(d.stats.mass)} label="toplu değişiklik (5+ deployment birlikte)" />
        <Stat value={c.incidents ? `${c.after_change} / ${c.incidents}` : "—"} label="olay bir değişiklikten sonraki 1 saatte başladı" hint={c.since ? `${fmtDate(c.since)}'den beri` : undefined} />
      </div>

      {d.rolled_back.length > 0 && (
        <Panel className="flex items-start gap-3 border-warn/40 p-4">
          <Undo2 size={18} className="mt-0.5 shrink-0 text-warn" />
          <div className="flex flex-col gap-1.5 text-[14px]">
            <b className="font-semibold">{d.rolled_back.length} deployment şu an en son sürümünü değil, daha eski bir ReplicaSet'i çalıştırıyor (geri alınmış durumda)</b>
            <ul className="flex flex-col gap-1 font-mono text-[12.5px] text-ink-2">
              {d.rolled_back.map((r) => (
                <li key={r.namespace + r.deployment}>
                  <span className="text-ink-3">{r.namespace}/</span><span className="font-medium text-ink">{r.deployment}</span>
                  <span> · çalışan: {r.running.join(", ")} · en yeni: {r.newest}</span>
                </li>
              ))}
            </ul>
            <p className="text-ink-2">Kontrol: <code className="font-mono text-[12.5px]">kubectl -n &lt;ns&gt; rollout history deployment/&lt;ad&gt;</code></p>
          </div>
        </Panel>
      )}

      {d.schedules.length > 0 && (
        <Panel className="flex items-start gap-3 border-warn/40 p-4">
          <CalendarClock size={18} className="mt-0.5 shrink-0 text-warn" />
          <div className="flex flex-col gap-1.5 text-[14px]">
            {d.schedules.map((s) => (
              <p key={s.time}>
                <b className="font-semibold">Her gün {s.time}'de {s.deployments} deployment yeniden başlatılıyor</b>
                <span className="text-ink-2"> (son {s.days} günün her birinde, aynı image ile).</span>
              </p>
            ))}
            <p className="text-ink-2">
              Bu büyük ihtimalle zamanlanmış bir iş (CronJob ya da pipeline). Aynı saat aralığında tetiklenen alert'ler (ör. sabah 07'deki yığılma) bununla
              ilgili olabilir. Gerekli değilse kaldırmak hem alert gürültüsünü hem de pod'ların gereksiz yere soğuk başlamasını azaltır.
            </p>
            <details className="text-[13px] text-ink-2">
              <summary className="cursor-pointer">Hangi deployment'lar</summary>
              <p className="mt-1.5 font-mono text-[12px] leading-relaxed">{d.schedules[0].names.join(", ")}</p>
            </details>
          </div>
        </Panel>
      )}

      <Section title="Zaman çizelgesi" aside={`Son ${d.window_days} gün; daha eskisi Prometheus'ta tutulmuyor`}>
        <div className="flex flex-wrap items-center gap-2">
          {([["all", "Hepsi"], ["release", "Sadece sürüm değişiklikleri"], ["incident", "Sonrasında olay olanlar"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setFilter(k)}
              className={`rounded-md border px-2.5 py-1 text-[13px] ${filter === k ? "border-accent bg-accent-soft text-accent" : "border-edge text-ink-2"}`}>{l}</button>
          ))}
          <label className="ml-1 flex items-center gap-2 text-[13px] text-ink-2">
            <input id="ch-sched" type="checkbox" checked={hideScheduled} onChange={(e) => setHideScheduled(e.target.checked)} /> Günlük zamanlı restart'ları gizle
          </label>
        </div>
        {days.length === 0 ? <Empty>Bu filtreyle değişiklik yok.</Empty> : days.map(([day, list]) => (
          <div key={day} className="flex flex-col gap-2.5">
            <h3 className="text-[13px] font-semibold tracking-wide text-ink-3 uppercase">{day}</h3>
            {list.map((b) => <ChangeBatchCard key={b.id} b={b} />)}
          </div>
        ))}
      </Section>
    </>
  );
}
