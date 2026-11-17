import { useState } from "react";
import { ArrowRight, Check, Copy, Wrench } from "lucide-react";
import type { Fix } from "../lib/types";
import { FINDING, Panel, Pill } from "./ui";

function val(v: string | number | boolean | null): string {
  if (v === true) return "açık";
  if (v === false) return "kapalı";
  if (v === null || v === "") return "—";
  return String(v);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(false);
  return (
    <button type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text)
          .then(() => { setOk(true); setErr(false); setTimeout(() => setOk(false), 1500); })
          .catch(() => setErr(true));
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[13px] text-ink-2 hover:text-ink">
      {ok ? <Check size={13} /> : <Copy size={13} />} {ok ? "Kopyalandı" : err ? "Kopyalanamadı, elle seç" : label}
    </button>
  );
}

/** Kural sayfasında "şunu şu yap" paneli: bulgulardan türetilmiş somut alan değişiklikleri. */
export default function FixPanel({ fix, title }: { fix: Fix; title: string }) {
  const [open, setOpen] = useState(false);
  const json = fix.rule ? JSON.stringify(fix.rule, null, 2) : "";

  return (
    <Panel className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><Wrench size={18} /></span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-semibold">Önerilen düzeltme</h3>
          <p className="text-[13px] text-ink-2">
            Bulgulardan türetilen alan değişiklikleri. Portal Grafana'ya yazmaz; değişikliği sen gözden geçirip uygularsın.
          </p>
        </div>
      </div>

      {fix.changes.length > 0 ? (
        <div className="flex flex-col divide-y divide-edge-soft rounded-md border border-edge-soft">
          {fix.changes.map((c) => (
            <div key={c.field} className="flex flex-col gap-1.5 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={FINDING[c.code]?.tone ?? "mute"}>{FINDING[c.code]?.label ?? c.code}</Pill>
                <span className="text-[13.5px] font-medium">{c.label}</span>
                <span className="flex items-center gap-2 font-mono text-[12.5px]">
                  <span className="text-ink-3 line-through">{val(c.from)}</span>
                  <ArrowRight size={12} className="text-ink-3" />
                  <span className="font-medium text-accent">{val(c.to)}</span>
                </span>
              </div>
              <p className="text-[13px] text-ink-2">{c.why}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[13.5px] text-ink-2">Bu kuralda mekanik olarak türetilebilecek bir değişiklik yok; aşağıdakiler karar gerektiriyor.</p>
      )}

      {fix.manual.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold tracking-wider text-ink-3 uppercase">Karar gerektirenler</span>
          <ul className="flex flex-col gap-1.5">
            {fix.manual.map((x) => (
              <li key={x.code} className="flex flex-wrap items-start gap-2 text-[13.5px] text-ink-2">
                <Pill tone={FINDING[x.code]?.tone ?? "mute"}>{FINDING[x.code]?.label ?? x.code}</Pill>
                <span className="min-w-0 flex-1">{x.what}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {fix.rule && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setOpen((v) => !v)} className="text-[13px] font-medium text-accent">
              {open ? "Düzeltilmiş tanımı gizle" : "Düzeltilmiş kural tanımını gör"}
            </button>
            <CopyButton text={json} label="Tanımı kopyala" />
            <span className="text-[12px] text-ink-3">Grafana'da kuralı aç → JSON olarak düzenle → yapıştır</span>
          </div>
          {open && (
            <pre className="max-h-96 overflow-auto rounded-md bg-edge-soft p-3 font-mono text-[12px] leading-relaxed">{json}</pre>
          )}
          <p className="text-[12px] text-ink-3">
            Tanım, "{title}" kuralının Grafana'dan okunan hali üzerine yukarıdaki değişiklikler uygulanarak üretildi.
            Sunucunun kendi tuttuğu alanlar (id, updated) çıkarıldı.
          </p>
        </div>
      )}
    </Panel>
  );
}
