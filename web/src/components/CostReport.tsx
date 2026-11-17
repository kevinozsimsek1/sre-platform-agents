import { useState } from "react";
import { FileDown } from "lucide-react";
import type { QueryCost } from "../lib/types";
import { fmtDate, fmtDateTime, fmtFull, fmtNum } from "../lib/format";

const usd = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const AY_UZUN = new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric", timeZone: "UTC" });
const ay = (iso: string) => AY_UZUN.format(new Date(`${iso.slice(0, 10)}T12:00:00Z`));
const INK = "#1f2937";
const MUTED = "#6b7280";
const ACCENT = "#00A5DB";

function qty(usageType: string, q: number): string {
  if (/Bytes/i.test(usageType)) return `${fmtNum(q)} GB`;
  if (/GMD-Metrics|GMWI|ObservationUsage|Requests/i.test(usageType)) return `${fmtNum(q)} adet`;
  return fmtNum(q);
}

const KIND: Record<string, string> = {
  logs_window: "Log taraması", logs_duplicate: "Kopya kural", dashboard_refresh: "Yenileme sıklığı",
  dashboard_duplicate: "Kopya dashboard", widget_dimensions: "Sorgu kapsamı", log_ingest: "Log hacmi",
};

function table(head: string[], rows: (string | number)[][], widths: (string | number)[]) {
  return {
    table: {
      headerRows: 1, widths,
      body: [head.map((h) => ({ text: h, style: "th" })), ...rows.map((r) => r.map((c, i) => ({
        text: String(c), fontSize: 8.5, alignment: i === 0 ? "left" : "right",
      })))],
    },
    layout: {
      hLineWidth: (i: number) => (i <= 1 ? 0.8 : 0.4),
      vLineWidth: () => 0,
      hLineColor: (i: number) => (i <= 1 ? "#d1d5db" : "#eceff3"),
      paddingTop: () => 3, paddingBottom: () => 3,
    },
    margin: [0, 2, 0, 10],
  };
}

export const SECTIONS = [
  { id: "fatura", label: "Gerçek fatura" },
  { id: "yontem", label: "Rakam nasıl bulundu" },
  { id: "dashboard", label: "Dashboard ve widget kırılımı" },
  { id: "loglar", label: "Logs Insights taraması" },
  { id: "gorevler", label: "Yapılacaklar" },
  { id: "kazanc", label: "Tamamlanan iyileştirmeler" },
] as const;
export type SectionId = typeof SECTIONS[number]["id"];

/** Sunum ve arşiv için rapor. `pick` ile yalnızca istenen bölümler yazılır. */
export function buildDoc(d: QueryCost, pick?: Set<string>): any {
  const on = (id: SectionId) => !pick || pick.has(id);
  const { bill, attribution: at, savings } = d;
  const content: any[] = [
    { text: "PROD GÖZLEMLENEBİLİRLİK MALİYETİ", style: "eyebrow" },
    { text: "CloudWatch sorgu maliyeti raporu", style: "title" },
    {
      text: bill.available
        ? `Kaynak: AWS Cost Explorer · ${bill.service}${bill.account ? ` · hesap ${bill.account}` : ""}`
        : "Gerçek fatura okunamadı; rapor yalnızca sorgu ölçümlerini içerir.",
      style: "lede",
    },
  ];

  let no = 0;
  if (bill.available && on("fatura")) {
    content.push({ text: `${++no}. Gerçek fatura`, style: "h2" });
    content.push({
      text: "Aşağıdaki tutarlar tahmin değil, AWS'nin kestiği faturadaki satırlardır.",
      style: "note",
    });
    content.push(table(
      ["Ay", "Toplam"],
      bill.months.map((m) => [`${ay(m.start)}${m.partial ? " (sürüyor)" : ""}`, usd(m.total)]),
      ["*", 80],
    ));
    const full = bill.months.filter((m) => !m.partial);
    if (full.length >= 2) {
      const f = full[0], l = full[full.length - 1];
      const pct = f.total ? Math.round(((l.total - f.total) / f.total) * 100) : 0;
      content.push({
        text: `${ay(f.start)} ayından ${ay(l.start)} ayına değişim: %${Math.abs(pct)} ${pct > 0 ? "artış" : pct < 0 ? "azalış" : "değişim yok"}`,
        style: "note", margin: [0, -6, 0, 10],
      });
    }
    content.push({ text: `${ay(bill.last_full.start)} kalemleri`, style: "h3" });
    content.push(table(
      ["Kalem", "Miktar", "Tutar"],
      [...bill.last_full.items.map((i) => [`${i.label}  (${i.usage_type})`, qty(i.usage_type, i.quantity), usd(i.cost)]),
       ["TOPLAM", "", usd(bill.last_full.total)]],
      ["*", 85, 65],
    ));

  }

  if (bill.available && on("yontem")) {
    content.push({ text: `${++no}. Rakam nasıl bulundu`, style: "h2" });
    content.push({
      ol: [
        "Toplam tutar ve metrik sayısı AWS Cost Explorer'dan okunur (CW:GMD-Metrics satırı).",
        "Her alert kuralının ve her panelin kaç metrik istediği CloudWatch ListMetrics ile ölçülür, değerlendirme ya da yenileme sıklığıyla çarpılır.",
        "Fatura bu ölçülen yüke oranla paylaştırılır; tutarlar pay gösterir, sıralama ölçüme dayanır.",
      ],
      fontSize: 9.5, margin: [0, 0, 0, 8],
    });
    if (at.load_vs_billed != null) {
      content.push({
        text: `Sınır: ölçülen yük ayda ${fmtNum(at.total_load_month)} metrik, faturalanan ${fmtNum(at.real_metrics_month)} metriğin ${at.load_vs_billed} katı. `
          + "Grafana sorgu anında tam eşleşme ve gruplama yaptığı için tanımların eşleşebileceği her metriği istemez; bu yüzden ölçülen yük bir üst sınırdır.",
        style: "note",
      });
    }
    content.push({
      text: "Not: Aşağıdaki tutarlar faturanın ilgili kaleme düşen payıdır. AWS dashboard ya da kural başına fatura kesmez; "
        + "pay, ölçülen sorgu yüküne oranla hesaplanmıştır.",
      style: "note",
    });
    content.push(table(
      ["Pay", "Metrik / ay", "Tutar"],
      [
        ["Alert kuralları (7/24 çalışır)", fmtNum(at.rule_metrics_month ?? 0), usd(at.rule_cost_month)],
        ["Dashboard'lar (açıkken)", fmtNum(at.dashboard_metrics_month ?? 0), usd(at.dashboard_cost_month)],
        ["Metrik sorgusu kalemi, toplam", fmtNum(at.real_metrics_month), usd(at.real_cost_month)],
      ],
      ["*", 85, 65],
    ));
    content.push(table(
      ["Diğer kalemler", "Miktar", "Tutar"],
      [
        ["Logs Insights taraması", `${fmtNum(bill.scanned.quantity)} GB`, usd(bill.scanned.cost)],
        ["Log alımı", `${fmtNum(bill.ingest.quantity)} GB`, usd(bill.ingest.cost)],
      ],
      ["*", 85, 65],
    ));
  }

  const dash = d.dashboards.filter((x) => (x.real_cost_month ?? 0) > 0).slice(0, 12);
  if (dash.length && on("dashboard")) {
    content.push({ text: `${++no}. En pahalı dashboard'lar`, style: "h2", pageBreak: "before" });
    content.push(table(
      ["Dashboard", "Yenileme", "Metrik/yenileme", "Aylık pay"],
      dash.map((x) => [`${x.title}  (org ${x.org}${x.folder ? ` / ${x.folder}` : ""})`,
        x.refresh ?? "kapalı", fmtNum(x.metrics_per_refresh ?? x.cloudwatch_metric), usd(x.real_cost_month)]),
      ["*", 55, 70, 60],
    ));
    const top = dash[0];
    if (top?.widgets?.length) {
      content.push({ text: `«${top.title}» panel kırılımı`, style: "h3" });
      content.push(table(
        ["Panel", "Metrik", "Aylık pay"],
        top.widgets.slice(0, 10).map((w) => [w.title, fmtNum(w.metrics_per_refresh ?? w.metric_queries), usd(w.real_cost_month)]),
        ["*", 60, 60],
      ));
    }
  }

  if (d.log_rules.length && on("loglar")) {
    content.push({ text: `${++no}. Logs Insights: yeniden tarama`, style: "h2" });
    content.push({
      text: "Sorgu penceresi değerlendirme aralığından uzun olduğu sürece aynı loglar tekrar taranır. "
        + "Pencere ile aralığı eşitlemek tarama hacmini aynı oranda düşürür.",
      style: "note",
    });
    const rows: (string | number)[][] = [];
    for (const r of d.log_rules) {
      for (const l of r.logs) {
        rows.push([r.title.trim(), `${l.window_min} dk`, `${r.every_s} sn`,
          l.overlap ? `${l.overlap}x` : "—", String(l.groups.length), fmtNum(r.evals_month)]);
      }
    }
    content.push(table(["Kural", "Pencere", "Sıklık", "İsraf", "Log grubu", "Tarama/ay"], rows, ["*", 45, 40, 36, 52, 58]));
  }

  const open = d.tasks.filter((t) => !t.assignee?.done_at);
  if (open.length && on("gorevler")) {
    const total = open.reduce((n, t) => n + (t.saving_usd ?? 0), 0);
    content.push({ text: `${++no}. Yapılacaklar`, style: "h2", pageBreak: "before" });
    content.push({
      text: `${open.length} açık görev · hesaplanabilen aylık kazanç ${usd(total)}`,
      style: "note",
    });
    for (const t of open) {
      content.push({
        table: {
          widths: ["*"],
          body: [[{
            stack: [
              { text: `${KIND[t.kind] ?? t.kind} · ${t.where}`, fontSize: 8, color: MUTED },
              { text: t.title, fontSize: 10, bold: true, margin: [0, 2, 0, 3] },
              {
                columns: [
                  { text: t.saving_usd != null ? `Kazanç: ${usd(t.saving_usd)}/ay` : `Şu an: ${usd(t.current_usd)}/ay`,
                    fontSize: 8.5, bold: true, color: t.saving_usd != null ? "#0e8a68" : INK, width: 130 },
                  { text: t.saving_note, fontSize: 8.5, color: MUTED },
                  { text: t.assignee ? `Atanan: ${t.assignee.to}` : "Atanmadı", fontSize: 8.5, alignment: "right", width: 90 },
                ], margin: [0, 0, 0, 3],
              },
              { text: "Ne yapılacak", fontSize: 7.5, bold: true, color: MUTED },
              { text: t.fix, fontSize: 9 },
              ...(t.why ? [{ text: t.why, fontSize: 8, color: MUTED, margin: [0, 2, 0, 0] }] : []),
            ],
            fillColor: "#f8fafc", margin: [6, 5, 6, 6],
          }]],
        },
        layout: "noBorders", margin: [0, 0, 0, 6], unbreakable: true,
      });
    }
  }

  if (savings.count > 0 && on("kazanc")) {
    content.push({ text: `${++no}. Tamamlanan iyileştirmeler`, style: "h2" });
    content.push(table(
      ["Görev", "Kim", "Tarih", "Aylık", "Bugüne kadar"],
      [...savings.done.map((x) => [x.title, x.to ?? "—", fmtDate(x.done_at), usd(x.saving_usd), usd(x.accrued_usd)]),
       ["TOPLAM", "", "", usd(savings.monthly_usd), usd(savings.accrued_usd)]],
      ["*", 55, 60, 50, 65],
    ));
  }

  const made = fmtFull(Date.now());
  return {
    info: { title: "CloudWatch sorgu maliyeti raporu", author: "Nebim SRE Portal" },
    pageMargins: [38, 36, 38, 44],
    defaultStyle: { font: "Roboto", fontSize: 10, color: INK, lineHeight: 1.25 },
    styles: {
      eyebrow: { fontSize: 8, bold: true, color: MUTED, characterSpacing: 1.2 },
      title: { fontSize: 19, bold: true, margin: [0, 3, 0, 4] },
      lede: { fontSize: 9, color: MUTED, margin: [0, 0, 0, 14] },
      h2: { fontSize: 13, bold: true, color: ACCENT, margin: [0, 8, 0, 5] },
      h3: { fontSize: 10.5, bold: true, margin: [0, 4, 0, 3] },
      th: { fontSize: 8, bold: true, color: MUTED },
      note: { fontSize: 8.5, color: MUTED, margin: [0, 0, 0, 7] },
    },
    footer: (page: number, pages: number) => ({
      columns: [
        { text: `Nebim SRE Portal · ${made}`, color: MUTED },
        { text: `${page} / ${pages}`, alignment: "right", color: MUTED },
      ],
      fontSize: 7.5, margin: [38, 14, 38, 0],
    }),
    content,
  };
}

export default function CostReport({ d }: { d: QueryCost }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [panel, setPanel] = useState(false);
  const [pick, setPick] = useState<Set<string>>(new Set(SECTIONS.map((x) => x.id)));

  const toggle = (id: string) => setPick((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const download = async () => {
    setBusy(true); setErr(null);
    try {
      const [{ default: pdfMake }, fonts] = await Promise.all([
        import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts"),
      ]);
      const f = (fonts as any).default ?? fonts;
      (pdfMake as any).vfs = f.pdfMake?.vfs ?? f.vfs ?? f;
      const day = fmtDateTime(Date.now()).slice(0, 10).replace(/\./g, "-");
      pdfMake.createPdf(buildDoc(d, pick)).download(`sorgu-maliyeti-${day}.pdf`);
      setPanel(false);
    } catch (e) {
      setErr((e as Error).message || "PDF oluşturulamadı");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="relative inline-flex flex-col items-end gap-0.5">
      <button type="button" onClick={() => setPanel((v) => !v)} aria-expanded={panel}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white">
        <FileDown size={13} /> Rapor indir (PDF)
      </button>
      {panel && (
        <span role="dialog" aria-label="Rapor bölümleri"
          className="absolute top-9 right-0 z-30 flex w-[min(20rem,calc(100vw-2.5rem))] flex-col gap-2 rounded-lg border border-edge bg-panel p-3 text-left shadow-xl">
          <span className="text-[12.5px] font-semibold">Rapora hangi bölümler girsin?</span>
          {SECTIONS.map((x) => (
            <label key={x.id} className="flex items-center gap-2 text-[13px] text-ink-2">
              <input type="checkbox" checked={pick.has(x.id)} onChange={() => toggle(x.id)} />
              {x.label}
            </label>
          ))}
          <span className="flex items-center gap-2 pt-1">
            <button type="button" onClick={download} disabled={busy || pick.size === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60">
              <FileDown size={13} /> {busy ? "Hazırlanıyor" : "İndir"}
            </button>
            <button type="button" onClick={() => setPick(new Set(SECTIONS.map((y) => y.id)))} className="text-[12.5px] text-accent">Hepsi</button>
            <button type="button" onClick={() => setPanel(false)} className="ml-auto text-[12.5px] text-ink-3">Kapat</button>
          </span>
          {err && <span className="text-[12px] text-crit">{err}</span>}
        </span>
      )}
    </span>
  );
}
