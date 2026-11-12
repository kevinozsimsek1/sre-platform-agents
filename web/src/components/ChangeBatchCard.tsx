import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, RotateCcw, Rocket } from "lucide-react";
import type { ChangeBatch } from "../lib/types";
import { fmtDateTime, fmtTime } from "../lib/format";
import { Panel, Pill } from "./ui";

const KIND = {
  release: { label: "yeni sürüm", tone: "accent" as const },
  restart: { label: "yeniden başlatma", tone: "mute" as const },
  unknown: { label: "değişiklik", tone: "mute" as const },
};

/** Bir değişiklik partisi: aynı anda (5 dk içinde) değişen deployment'lar. */
export default function ChangeBatchCard({ b, showIncidents = true }: { b: ChangeBatch; showIncidents?: boolean }) {
  const [open, setOpen] = useState(b.items.length <= 4);
  const items = open ? b.items : b.items.slice(0, 3);
  const isRelease = b.releases > 0;
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`grid size-7 place-items-center rounded-md ${isRelease ? "bg-accent-soft text-accent" : "bg-edge-soft text-ink-2"}`}>
          {isRelease ? <Rocket size={15} /> : <RotateCcw size={15} />}
        </span>
        <span className="font-semibold">{fmtDateTime(b.start)}{b.end - b.start > 60_000 && ` – ${fmtTime(b.end)}`}</span>
        {b.minutes_before != null && <span className="text-[13px] text-ink-2">olaydan {b.minutes_before} dk önce</span>}
        {b.mass && <Pill tone="warn">toplu · {b.deployments} deployment</Pill>}
        {b.releases > 0 && <Pill tone="accent">{b.releases} yeni sürüm</Pill>}
        {b.restarts > 0 && <Pill tone="mute">{b.restarts} yeniden başlatma</Pill>}
        {b.related && <Pill tone="crit">olayla ilgili servis</Pill>}
      </div>

      <ul className="flex flex-col divide-y divide-edge-soft rounded-md border border-edge-soft">
        {items.map((i) => (
          <li key={i.namespace + i.deployment + i.t_ms} className="grid gap-1 px-3 py-2 text-[13px] sm:grid-cols-[1fr_auto] sm:items-center">
            <span className="min-w-0 truncate"><span className="text-ink-3">{i.namespace}/</span><span className="font-medium">{i.deployment}</span></span>
            <span className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-ink-2">
              {i.kind === "release" ? (
                <><span className="text-ink-3">{i.prev_version}</span><ArrowRight size={12} className="text-ink-3" /><span className="text-accent">{i.version}</span></>
              ) : (
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
