import { useState } from "react";
import { BookOpen, Download } from "lucide-react";
import type { RuleDetail } from "../lib/types";
import { fmtFull, fmtNum } from "../lib/format";
import { Panel } from "./ui";

const MAX = 8000;

const PLACEHOLDER = `Bu alert gelince ne yapılır? Örnek:
1. Önce şu dashboard'a bak: https://...
2. Genelde sebep X oluyor, kontrol: kubectl -n ... get pods
3. Y ise Z ekibine haber ver.
Geçen sefer: ...`;

const slug = (s: string) =>
  s.toLocaleLowerCase("tr-TR").replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c] ?? c)
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "alert";

/** Yazılan metin + kuralın bilgileri + otomatik "nereden bakılır" rehberi → PDF tanımı. */
export function buildDoc(d: RuleDetail, text: string): any {
  const r = d.rule;
  const accent = "#1f6feb";
  const muted = "#6b7280";
  const routing = d.routing.map((c) => c.name).join(", ") || "—";
  const desc = r.annotations.summary || r.annotations.description;

  const content: any[] = [
    { text: "RUNBOOK", style: "eyebrow" },
    { text: r.title, style: "title" },
    {
      table: {
        widths: [110, "*"],
        body: [
          ["Önem", r.severity ?? "—"],
          ["Klasör / grup", `${r.folder} / ${r.group}`],
          ["Bekleme süresi", r.for],
          ["Bildirim", routing],
          ["Son 30 gün", `${fmtNum(r.fires)} tetiklenme`],
          ["Grafana", { text: "Kuralı Grafana'da aç", link: d.links.grafana, color: accent }],
        ].map(([k, v]) => [{ text: k, color: muted }, v]),
      },
      layout: "noBorders", margin: [0, 4, 0, 12],
    },
  ];
  if (desc) content.push({ text: desc, color: "#374151", margin: [0, 0, 0, 12] });

  content.push({ text: "Ne yapılır", style: "h2" });
  content.push({ text: text.trim(), margin: [0, 0, 0, 14], lineHeight: 1.3 });

  if (d.investigate.length) {
    content.push({ text: "Nereden bakılır", style: "h2" });
    for (const g of d.investigate) {
      content.push({ text: g.title, bold: true, margin: [0, 6, 0, 2] });
      if (g.why) content.push({ text: g.why, color: muted, fontSize: 9.5, margin: [0, 0, 0, 3] });
      if (g.links.length) content.push({ ul: g.links.map((l) => ({ text: l.label, link: l.url, color: accent })), fontSize: 9.5, margin: [0, 0, 0, 3] });
      for (const c of g.commands) content.push({ table: { widths: ["*"], body: [[{ text: c, fontSize: 8.5, fillColor: "#f3f4f6" }]] }, layout: "noBorders", margin: [0, 1, 0, 1] });
    }
    content.push({ text: "Linkler tıklandığı andaki zaman aralığına değil, son tetiklenmeye ayarlıdır; açınca aralığı kendin değiştir.", color: muted, fontSize: 8.5, margin: [0, 6, 0, 14] });
  }

  const queries = d.queries.filter((q) => q.text);
  if (queries.length) {
    content.push({ text: "Kuralın sorgusu", style: "h2" });
    for (const q of queries) {
      content.push({ text: `${q.ref} · ${q.kind}${q.condition ? " · koşul" : ""}`, color: muted, fontSize: 9, margin: [0, 4, 0, 1] });
      content.push({ table: { widths: ["*"], body: [[{ text: q.text, fontSize: 8.5, fillColor: "#f3f4f6" }]] }, layout: "noBorders" });
    }
  }

  const made = fmtFull(Date.now());
  return {
    info: { title: `Runbook - ${r.title}` },
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: "Roboto", fontSize: 10.5 },
    styles: {
      eyebrow: { fontSize: 8.5, bold: true, color: muted, characterSpacing: 1 },
      title: { fontSize: 18, bold: true, margin: [0, 2, 0, 8] },
      h2: { fontSize: 13, bold: true, margin: [0, 4, 0, 6] },
    },
    footer: (page: number, pages: number) => ({
      columns: [{ text: `Nebim SRE Portal · ${made}`, color: muted }, { text: `${page} / ${pages}`, alignment: "right", color: muted }],
      fontSize: 8, margin: [40, 16, 40, 0],
    }),
    content,
  };
}

/** PDF'i tarayıcıda üretip indirir. Hiçbir şey sunucuya gitmez. */
async function downloadPdf(d: RuleDetail, text: string) {
  const [{ default: pdfMake }, fonts] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  const f = (fonts as any).default ?? fonts;
  (pdfMake as any).vfs = f.pdfMake?.vfs ?? f.vfs ?? f;
  pdfMake.createPdf(buildDoc(d, text)).download(`runbook-${slug(d.rule.title)}.pdf`);
}

/** Kural sayfasında runbook yazma alanı. Portal metni saklamaz; yazılan şey PDF olarak bilgisayara iner. */
export function RunbookPanel({ d }: { d: RuleDetail }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const download = async () => {
    setBusy(true); setErr(null);
    try { await downloadPdf(d, text); } catch (e) { setErr((e as Error).message || "PDF oluşturulamadı"); } finally { setBusy(false); }
  };

  return (
    <Panel className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen size={16} className="text-ink-2" />
          <h3 className="font-semibold">Runbook</h3>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[13px] text-ink-2 hover:text-ink">
            Runbook yaz
          </button>
        )}
      </div>
      {!open ? (
        <p className="text-[13.5px] text-ink-2">
          Bu alert için adımları yaz, PDF olarak indir. PDF'e kuralın bilgileri, sorgusu ve "nereden bakılır" linkleri de otomatik eklenir.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, MAX))} rows={9} placeholder={PLACEHOLDER} autoFocus
            className="w-full rounded-md border border-edge bg-canvas p-3 font-mono text-[13px] leading-relaxed" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={download} disabled={busy || !text.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">
              <Download size={13} /> {busy ? "Hazırlanıyor" : "PDF olarak indir"}
            </button>
            <button type="button" onClick={() => { setOpen(false); setText(""); }} className="px-2 py-1.5 text-[13px] text-ink-3 hover:text-ink">Kapat</button>
            <span className="ml-auto text-[12px] text-ink-3">Portal bu metni kaydetmez, sayfadan çıkınca silinir.</span>
            {err && <span className="w-full text-[13px] text-crit">{err}</span>}
          </div>
        </div>
      )}
    </Panel>
  );
}
