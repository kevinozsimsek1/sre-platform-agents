import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, RotateCcw, Rocket, Sparkles, Undo2 } from "lucide-react";
import type { ChangeBatch, ChangeItem } from "../lib/types";
import { fmtDate, fmtDateTime, fmtTime } from "../lib/format";
import { Panel, Pill } from "./ui";

const KIND = {
  release: { label: "yeni sürüm", tone: "accent" as const },
  rollback: { label: "geri alma", tone: "warn" as const },
  new: { label: "yeni deployment", tone: "accent" as const },
  restart: { label: "yeniden başlatma", tone: "mute" as const },
  unknown: { label: "image bilinmiyor", tone: "mute" as const },
};

const VERSION_KINDS = new Set<ChangeItem["kind"]>(["release", "rollback", "new"]);

/** Önceki sürümün prod'da kaldığı süre. */
function kept(ms: number, atLeast = false): string {
  const h = ms / 3_600_000;
  const plus = atLeast ? "+" : "";
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}${plus} dk kaldı`;
  if (h < 48) return `${Math.round(h)}${plus} saat kaldı`;
  return `${Math.round(h / 24)}${plus} gün kaldı`;
}

/** Sürüm değişikliği: önceki ve yeni sürüm, tarihleriyle. Geri almada "yeni" kutusu turuncu olur. */
function VersionChange({ i }: { i: ChangeItem }) {
  const rollback = i.kind === "rollback";
  return (
    <span className="flex flex-wrap items-stretch gap-2 font-sans">
      {i.kind !== "new" && (
        <>
          <span className="flex min-w-[11rem] flex-col gap-0.5 rounded-md border border-edge-soft bg-canvas px-2.5 py-1.5">
            <span className="text-[10.5px] font-semibold tracking-wider text-ink-3 uppercase">Önceki</span>
            <span className="font-mono text-[13px] text-ink-2">{i.prev_version ?? "—"}</span>
            {i.prev_since_ms && (
              <span className="text-[12.5px] text-ink-2" title={i.prev_since_exact ? fmtDateTime(i.prev_since_ms) : `Bu sürümün başlangıcı görünen aralıktan eski; görünen en eski kaydı ${fmtDateTime(i.prev_since_ms)}`}>
                {i.prev_since_exact ? "" : "en az "}{fmtDate(i.prev_since_ms)}'den beri
                <span className="ml-1.5 font-medium text-ink">{kept(i.t_ms - i.prev_since_ms, !i.prev_since_exact)}</span>
              </span>
            )}
          </span>
          <ArrowRight size={16} className="shrink-0 self-center text-ink-3" />
        </>
      )}
      <span className={`flex min-w-[11rem] flex-col gap-0.5 rounded-md border px-2.5 py-1.5 ${rollback ? "border-warn/50 bg-warn-soft" : "border-accent/40 bg-accent-soft"}`}>
        <span className={`text-[10.5px] font-semibold tracking-wider uppercase ${rollback ? "text-warn" : "text-accent"}`}>
          {rollback ? "Geri dönülen" : i.kind === "new" ? "İlk sürüm" : "Yeni"}
        </span>
        <span className="font-mono text-[13px] font-medium text-ink">{i.version ?? "—"}</span>
        <span className="text-[12.5px] text-ink-2">{fmtDateTime(i.t_ms)}</span>
      </span>
    </span>
  );
}

/** Bir değişiklik partisi: aynı anda (5 dk içinde) değişen deployment'lar. */
export default function ChangeBatchCard({ b, showIncidents = true }: { b: ChangeBatch; showIncidents?: boolean }) {
  const [open, setOpen] = useState(b.items.length <= 4);
  const items = open ? b.items : b.items.slice(0, 3);
  const rollbacks = b.rollbacks ?? 0;
  const fresh = b.new ?? 0;
  const Icon = rollbacks > 0 ? Undo2 : fresh > 0 ? Sparkles : b.releases > 0 ? Rocket : RotateCcw;
  const iconTone = rollbacks > 0 ? "bg-warn-soft text-warn" : b.releases + fresh > 0 ? "bg-accent-soft text-accent" : "bg-edge-soft text-ink-2";
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`grid size-7 place-items-center rounded-md ${iconTone}`}><Icon size={15} /></span>
        <span className="font-semibold">{fmtDateTime(b.start)}{b.end - b.start > 60_000 && ` – ${fmtTime(b.end)}`}</span>
        {b.minutes_before != null && <span className="text-[13px] text-ink-2">olaydan {b.minutes_before} dk önce</span>}
        {b.mass && <Pill tone="warn">toplu · {b.deployments} deployment</Pill>}
        {rollbacks > 0 && <Pill tone="warn">{rollbacks} geri alma</Pill>}
        {b.releases > 0 && <Pill tone="accent">{b.releases} yeni sürüm</Pill>}
        {fresh > 0 && <Pill tone="accent">{fresh} yeni deployment</Pill>}
        {b.restarts > 0 && <Pill tone="mute">{b.restarts} yeniden başlatma</Pill>}
        {b.related && <Pill tone="crit">olayla ilgili servis</Pill>}
      </div>

      <ul className="flex flex-col divide-y divide-edge-soft rounded-md border border-edge-soft">
        {items.map((i) => (
          <li key={i.namespace + i.deployment + i.t_ms} className="grid gap-2 px-3 py-2.5 text-[14px] sm:grid-cols-[1fr_auto] sm:items-center">
            <span className="min-w-0 truncate"><span className="text-ink-3">{i.namespace}/</span><span className="font-medium">{i.deployment}</span></span>
            <span className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-ink-2">
              {VERSION_KINDS.has(i.kind) ? <VersionChange i={i} /> : (
                <><span>{i.version ?? "—"}</span><Pill tone={KIND[i.kind].tone}>{KIND[i.kind].label}</Pill></>
              )}
            </span>
          </li>
        ))}
      </ul>
      {b.items.length > 3 && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="w-fit text-[12.5px] font-medium text-accent">
          {open ? "Daha az göster" : `${b.items.length - 3} deployment daha`}
        </button>
      )}

      {showIncidents && b.incidents_after && b.incidents_after.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md bg-crit-soft/50 px-3 py-2.5">
          <span className="text-[12.5px] font-medium">Sonraki 60 dakikada başlayan olaylar</span>
          <div className="flex flex-wrap gap-1.5">
            {b.incidents_after.map((i) => (
              <Link key={i.id} to={`/incidents/${i.id}`} className="rounded border border-edge bg-panel px-2 py-0.5 text-[12px] hover:border-accent">
                {fmtTime(i.start)} · {i.rules[0]?.title}{i.rules.length > 1 && ` +${i.rules.length - 1}`}
              </Link>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
