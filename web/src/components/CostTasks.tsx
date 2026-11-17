import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, ExternalLink, RotateCcw } from "lucide-react";
import { put } from "../lib/api";
import type { CostTask } from "../lib/types";
import { ago, fmtNum } from "../lib/format";
import { Empty, Panel, Pill, type Tone } from "./ui";

const usd = (n: number | null | undefined) =>
  n == null ? null : `$${n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TONE: Record<CostTask["severity"], Tone> = { crit: "crit", warn: "warn", info: "mute" };
const KIND: Record<string, string> = {
  logs_window: "Log taraması",
  logs_duplicate: "Kopya kural",
  dashboard_refresh: "Yenileme sıklığı",
  dashboard_duplicate: "Kopya dashboard",
  widget_dimensions: "Sorgu kapsamı",
  log_ingest: "Log hacmi",
};

function Card({ t, team }: { t: CostTask; team: string[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(t.links.length > 1);
  const [math, setMath] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["query-cost"] });
  const enc = encodeURIComponent(t.id).replace(/%3A/g, ":");

  const assign = useMutation({
    mutationFn: (to: string | null) => put(`/cost-tasks/${enc}/assignee`, { to }),
    onSuccess: refresh,
  });
  const done = useMutation({
    mutationFn: (v: boolean) => put(`/cost-tasks/${enc}/done`, { done: v }),
    onSuccess: refresh,
  });

  const a = t.assignee;
  const finished = !!a?.done_at;
  const saving = usd(t.saving_usd);

  return (
    <Panel className={`flex flex-col gap-3 p-4 ${finished ? "opacity-70" : ""} ${t.severity === "crit" ? "border-crit/40" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={TONE[t.severity]}>{KIND[t.kind] ?? t.kind}</Pill>
            {finished && <Pill tone="good">tamamlandı</Pill>}
            <span className="text-[12px] text-ink-3">{t.where}</span>
          </div>
          <h3 className={`text-[15px] font-semibold ${finished ? "line-through" : ""}`}>{t.title}</h3>
        </div>
        <div className="flex shrink-0 items-start gap-3">
          <div className="flex flex-col items-end gap-0.5">
            <span className="font-mono text-[17px] font-semibold text-crit tabular-nums">{usd(t.current_usd) ?? "—"}</span>
            <span className="text-[11.5px] text-ink-3">şu an / ay</span>
          </div>
          {saving && (
            <>
              <ArrowRight size={16} className="mt-1.5 shrink-0 text-ink-3" />
              <div className="flex flex-col items-end gap-0.5">
                <span className="font-mono text-[17px] font-semibold text-good tabular-nums">−{saving}</span>
                <span className="text-[11.5px] text-ink-3">yapılırsa kazanç</span>
                <span className="text-[11.5px] text-ink-3">{t.saving_note}</span>
              </div>
            </>
          )}
          {!saving && <span className="mt-1 max-w-[9rem] text-right text-[11.5px] text-ink-3">{t.saving_note}</span>}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 rounded-md bg-canvas p-3">
        <span className="text-[11px] font-semibold tracking-wider text-ink-3 uppercase">Ne yapılacak</span>
        <p className="text-[13.5px] text-ink-2">{t.fix}</p>
      </div>

      {open && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold tracking-wider text-ink-3 uppercase">Neden</span>
          <p className="text-[13px] break-words text-ink-2">{t.why}</p>
        </div>
      )}

      {math && (NASIL[t.kind] || t.math) && (
        <div className="flex flex-col gap-3 rounded-md border border-edge-soft bg-canvas p-3.5">
          {t.math && t.math.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold tracking-wider text-ink-3 uppercase">Hesap</span>
              <pre className="overflow-x-auto font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{t.math.join("\n")}</pre>
            </div>
          )}
          {NASIL[t.kind] && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-semibold tracking-wider text-crit uppercase">
                  {usd(t.current_usd)} · şu an / ay
                </span>
                <p className="text-[13px] leading-relaxed text-ink-2">{NASIL[t.kind].now}</p>
              </div>
              {saving && (
                <div className="flex flex-col gap-1">
                  <span className="text-[12px] font-semibold tracking-wider text-good uppercase">
                    −{saving} · yapılırsa kazanç
                  </span>
                  <p className="text-[13px] leading-relaxed text-ink-2">{NASIL[t.kind].save}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`as-${t.id}`}>Kime atanacak</label>
        <select id={`as-${t.id}`} value={a?.to ?? ""} disabled={assign.isPending}
          onChange={(e) => assign.mutate(e.target.value || null)}
          className="rounded-md border border-edge bg-panel px-2 py-1 text-[13px]">
          <option value="">Atanmadı</option>
          {team.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {a && (
          <button type="button" disabled={done.isPending} onClick={() => done.mutate(!finished)}
            className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[13px] text-ink-2 hover:text-ink">
            {finished ? <><RotateCcw size={13} /> Geri aç</> : <><CheckCircle2 size={13} /> Tamamlandı</>}
          </button>
        )}
        {a && <span className="text-[12px] text-ink-3">{finished ? `${ago(a.done_at!)} bitti` : `${ago(a.at)} atandı`}</span>}
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-[12.5px] font-medium text-accent">
          {open ? "Gerekçeyi gizle" : "Neden?"}
        </button>
        {(NASIL[t.kind] || t.math) && (
          <button type="button" onClick={() => setMath((v) => !v)} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent">
            <span className="grid size-[17px] place-items-center rounded-full border border-accent/60 text-[10.5px] font-semibold">i</span>
            {math ? "Hesabı gizle" : "Rakam nasıl hesaplandı?"}
          </button>
        )}
        {t.links.length > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {t.links.length > 1 && <span className="text-[12px] text-ink-3">{t.links.length} yeri aç:</span>}
            {t.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent-soft px-2.5 py-1 text-[12.5px] font-medium text-accent hover:border-accent">
                {l.label} <ExternalLink size={12} />
              </a>
            ))}
          </span>
        )}
        {(assign.error || done.error) && (
          <span className="w-full text-[12.5px] text-crit">{((assign.error || done.error) as Error).message}</span>
        )}
      </div>
    </Panel>
  );
}

/** "Şunu şöyle düzeltin" listesi: kişiye atanır, tamamlanınca işaretlenir. */
const CHIP = "rounded-full border px-3 py-1 text-[13px] whitespace-nowrap";

/** Her görev türü için: şu anki tutar ve kazanç nasıl bulundu. Sunumda sorulacak soru bu. */
const NASIL: Record<string, { now: ReactNode; save: ReactNode }> = {
  dashboard_refresh: {
    now: <>Faturadaki gerçek metrik sorgusu kaleminin bu dashboard'a düşen <b>payı</b>. Pay, dashboard'ın ölçülen
      yüküne göre hesaplanıyor: her panelin kaç metrik istediği CloudWatch'a sorulup (ListMetrics) yenileme
      sıklığıyla çarpılıyor. AWS dashboard başına fatura kesmez; bu yüzden tutar bir pay, fatura satırı değil.</>,
    save: <>Yenileme 1 dakikaya çıkarılınca sorgu sayısı aynı oranda azalır. Kazanç, mevcut payın bu oranla
      çarpımı: örneğin 10 saniyeden 1 dakikaya çıkmak yükü altıya böler, payın altı birimden beşi düşer.</>,
  },
  dashboard_duplicate: {
    now: <>Aynı adı taşıyan dashboard'ların <b>paylarının toplamı</b>. Her kopya ayrı ayrı sorgu attığı için
      faturadaki yükte her biri sayılır. Tutar, gerçek fatura kaleminin bu kopyalara düşen payıdır.</>,
    save: <>Kopyalar silinip tek dashboard bırakılınca, en pahalı olan dışındaki kopyaların payı tamamen ortadan
      kalkar. Kazanç, silinecek kopyaların payları toplamı.</>,
  },
  logs_window: {
    now: <>Faturadaki <span className="font-mono text-[12px]">DataScanned-Bytes</span> kaleminin (Logs Insights
      taraması) bu kurala düşen payı. Pay, kuralın tarama hacmine göre: sorgu penceresi × log grubu sayısı ×
      aylık tarama sayısı.</>,
    save: <>Pencere ile değerlendirme aralığı eşitlenirse her log bir kez taranır. Şu an kaç kat yeniden
      tarandığı kuralın tanımından kesin okunuyor; kazanç, mevcut payın o katsayıya bölünmesiyle kalan kısım.</>,
  },
  logs_duplicate: {
    now: <>Aynı sorguyu çalıştıran kuralların fazladan tarama payı. Birebir aynı pencere ve aynı log
      gruplarıyla çalıştıkları için tarama sayısı kural sayısı kadar katlanıyor.</>,
    save: <>Tek kurala indirilip seviyeler eşikle ayrılırsa tarama bir kez yapılır; fazladan kuralların payı
      tamamen kalkar.</>,
  },
  widget_dimensions: {
    now: <>Bu panelin, dashboard'ın payı içindeki kısmı. Panelin kaç metrik istediği ölçülüp (ListMetrics)
      dashboard'ın toplam ölçülen yüküne oranlanıyor.</>,
    save: <>Sayı verilmiyor: boyut tanımlanınca kaç metriğin düşeceği, hangi kaynakların seçileceğine bağlı.
      Kesin olan, sorgunun şu an birden çok metriğe açıldığı ve bunun ölçülmüş olduğu.</>,
  },
  log_ingest: {
    now: <>Bu rakam pay değil, <b>doğrudan fatura satırı</b>: CloudWatch Logs'a yazılan log hacminin aylık
      tutarı (<span className="font-mono text-[12px]">DataProcessing-Bytes</span>). Cost Explorer'dan okunuyor.</>,
    save: <>Sayı verilmiyor: kazanç, hangi logların kapatılacağına ve saklama sürelerinin ne kadar
      kısaltılacağına bağlı. Log maliyeti sayfasında hangi grubun ne kadar ürettiği grup grup ölçülmüş halde.</>,
  },
};

export default function CostTasks({ tasks, team }: { tasks: CostTask[]; team: string[] }) {
  const [showDone, setShowDone] = useState(false);
  const [who, setWho] = useState("");
  const [kind, setKind] = useState("");
  const [limit, setLimit] = useState(8);

  const open = tasks.filter((t) => !t.assignee?.done_at);
  const finished = tasks.filter((t) => t.assignee?.done_at);
  const base = showDone ? finished : open;
  const list = base.filter((t) =>
    (!who || (who === "none" ? !t.assignee : t.assignee?.to === who)) && (!kind || t.kind === kind));
  const shown = list.slice(0, limit);

  const totalSaving = open.reduce((n, t) => n + (t.saving_usd ?? 0), 0);
  const totalCurrent = open.reduce((n, t) => n + (t.current_usd ?? 0), 0);
  const assigned = open.filter((t) => t.assignee).length;
  const kinds = [...new Set(tasks.map((t) => t.kind))];
  const reset = () => setLimit(8);

  return (
    <div className="flex flex-col gap-3">
      <Panel className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3.5">
        <span className="flex items-baseline gap-1.5">
          <b className="font-mono text-[22px] font-semibold tabular-nums">{fmtNum(open.length)}</b>
          <span className="text-[13px] text-ink-2">açık görev</span>
        </span>
        {totalCurrent > 0 && (
          <span className="flex items-baseline gap-1.5">
            <b className="font-mono text-[22px] font-semibold text-crit tabular-nums">{usd(totalCurrent)}</b>
            <span className="text-[13px] text-ink-2">bu görevlere şu an ödenen / ay</span>
          </span>
        )}
        {totalSaving > 0 && (
          <span className="flex items-baseline gap-1.5">
            <b className="font-mono text-[22px] font-semibold text-good tabular-nums">−{usd(totalSaving)}</b>
            <span className="text-[13px] text-ink-2">hepsi yapılırsa kazanç</span>
          </span>
        )}
        <span className="flex items-baseline gap-1.5">
          <b className="font-mono text-[22px] font-semibold tabular-nums">{fmtNum(assigned)}</b>
          <span className="text-[13px] text-ink-2">birine atanmış</span>
        </span>
        {finished.length > 0 && (
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={showDone} onChange={(e) => { setShowDone(e.target.checked); reset(); }} />
            Tamamlananlar ({finished.length})
          </label>
        )}
      </Panel>

      <div className="flex flex-wrap items-center gap-1.5">
        {[{ v: "", l: `Herkes (${base.length})` }, { v: "none", l: `Atanmamış (${base.filter((t) => !t.assignee).length})` },
          ...team.map((n) => ({ v: n, l: `${n} (${base.filter((t) => t.assignee?.to === n).length})` }))].map((x) => (
          <button key={x.v || "all"} type="button" onClick={() => { setWho(x.v); reset(); }}
            className={`${CHIP} ${who === x.v ? "border-accent bg-accent-soft font-medium text-accent" : "border-edge text-ink-2 hover:text-ink"}`}>
            {x.l}
          </button>
        ))}
        <label className="sr-only" htmlFor="kind-filter">Görev türü</label>
        <select id="kind-filter" value={kind} onChange={(e) => { setKind(e.target.value); reset(); }}
          className="ml-auto rounded-md border border-edge bg-panel px-2 py-1 text-[13px]">
          <option value="">Tüm türler</option>
          {kinds.map((k) => <option key={k} value={k}>{KIND[k] ?? k}</option>)}
        </select>
      </div>

      {list.length === 0 ? (
        <Empty>{showDone ? "Bu süzgeçle tamamlanan görev yok." : "Bu süzgeçle açık görev yok."}</Empty>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {shown.map((t) => <Card key={t.id} t={t} team={team} />)}
          </div>
          {list.length > limit && (
            <button type="button" onClick={() => setLimit(list.length)} className="w-fit text-[13px] font-medium text-accent">
              {list.length - limit} görev daha
            </button>
          )}
        </>
      )}
    </div>
  );
}
