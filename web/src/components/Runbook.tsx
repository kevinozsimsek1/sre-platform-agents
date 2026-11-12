import { Fragment, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Pencil } from "lucide-react";
import { put } from "../lib/api";
import type { Runbook } from "../lib/types";
import { ago } from "../lib/format";
import { Panel } from "./ui";

const MAX = 4000;

/** Düz metin; satır sonları korunur, linkler tıklanır. */
export function RunbookText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
      {parts.map((p, i) => /^https?:\/\//.test(p)
        ? <a key={i} href={p} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">{p}</a>
        : <Fragment key={i}>{p}</Fragment>)}
    </div>
  );
}

const PLACEHOLDER = `Bu alert gelince ne yapılır? Örnek:
1. Önce şu dashboard'a bak: https://...
2. Genelde sebep X oluyor, kontrol: kubectl -n ... get pods
3. Y ise Z ekibine haber ver.
Geçen sefer: ...`;

/** Kural sayfasındaki runbook: ekibin bu alert için yazdığı adımlar. Herkes düzenleyebilir, değişiklik denetim kaydına düşer. */
export function RunbookPanel({ ruleKey, rb }: { ruleKey: string; rb: Runbook | null }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(rb?.text ?? "");
  const [org, uid] = ruleKey.split(":");
  const m = useMutation({
    mutationFn: () => put(`/alerts/rules/${org}/${uid}/runbook`, { text }),
    onSuccess: () => { ["rule", "incident"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setEdit(false); },
  });

  return (
    <Panel className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen size={16} className="text-ink-2" />
          <h3 className="font-semibold">Runbook</h3>
          {rb && <span className="text-[12px] text-ink-3">son değişiklik {ago(rb.at)}</span>}
        </div>
        {!edit && (
          <button type="button" onClick={() => { setText(rb?.text ?? ""); setEdit(true); }}
            className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[13px] text-ink-2 hover:text-ink">
            <Pencil size={13} /> {rb ? "Düzenle" : "Runbook yaz"}
          </button>
        )}
      </div>
      {edit ? (
        <div className="flex flex-col gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, MAX))} rows={8} placeholder={PLACEHOLDER}
            className="w-full rounded-md border border-edge bg-canvas p-3 font-mono text-[13px] leading-relaxed" autoFocus />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => m.mutate()} disabled={m.isPending} className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60">Kaydet</button>
            <button type="button" onClick={() => setEdit(false)} className="px-2 py-1.5 text-[13px] text-ink-3 hover:text-ink">Vazgeç</button>
            <span className="ml-auto text-[12px] text-ink-3">{text.length}/{MAX} · boş kaydedersen silinir</span>
            {m.error && <span className="w-full text-[13px] text-crit">{(m.error as Error).message}</span>}
          </div>
        </div>
      ) : rb ? (
        <RunbookText text={rb.text} />
      ) : (
        <p className="text-[13.5px] text-ink-2">
          Bu alert için henüz runbook yok. Alert gelince ilk ne yapılacağını, genelde sebebin ne çıktığını yaz; nöbetteki kişi aynı şeyi baştan araştırmasın.
        </p>
      )}
    </Panel>
  );
}
