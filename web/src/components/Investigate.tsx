import { useState } from "react";
import { Check, Copy, ExternalLink, Terminal } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Panel } from "./ui";

export type GuideLink = { label: string; url: string; kind: "grafana" | "aws" | string };
export type GuideItem = { title: string; why: string; links: GuideLink[]; commands: string[] };

export function CopyLine({ cmd }: { cmd: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md bg-edge-soft px-2.5 py-1.5">
      <Terminal size={13} className="mt-1 shrink-0 text-ink-3" />
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] whitespace-pre">{cmd}</code>
      <button
        type="button"
        aria-label="Komutu kopyala"
        className="shrink-0 text-ink-3 hover:text-ink"
        onClick={() => {
          navigator.clipboard?.writeText(cmd).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }).catch(() => {});
        }}
      >
        {ok ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

const KIND: Record<string, string> = { grafana: "Grafana", aws: "AWS" };

/** "Nereden bakılır": o zaman aralığına ayarlı Grafana/AWS linkleri, komutlar ve ipuçları. */
export default function Investigate({ items, compact = false }: { items: GuideItem[]; compact?: boolean }) {
  if (!items?.length) return null;
  return (
    <div className={`grid gap-3 ${compact ? "" : "lg:grid-cols-2"}`}>
      {items.map((g) => (
        <Panel key={g.title} className="flex flex-col gap-2.5 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-[14.5px] font-semibold">{g.title}</h3>
            {g.why && <p className="text-[13px] leading-relaxed text-ink-2">{g.why}</p>}
          </div>
          {g.links.length > 0 && (
            <ul className="flex flex-col gap-1">
              {g.links.map((l) => (
                <li key={l.url}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex items-start gap-2 rounded-md px-1.5 py-1 text-[13.5px] hover:bg-edge-soft"
                  >
                    <span className="mt-0.5 w-14 shrink-0 font-mono text-[10.5px] tracking-wide text-ink-3 uppercase">{KIND[l.kind] ?? l.kind}</span>
                    <span className="min-w-0 flex-1 text-accent group-hover:underline">{l.label}</span>
                    <ExternalLink size={13} className="mt-1 shrink-0 text-ink-3" />
                  </a>
                </li>
              ))}
            </ul>
          )}
          {g.commands.length > 0 && <div className="flex flex-col gap-1.5">{g.commands.map((c) => <CopyLine key={c} cmd={c} />)}</div>}
        </Panel>
      ))}
    </div>
  );
}

export function GuideNote() {
  const cfg = useQuery<{ aws_account: string | null }>({ queryKey: ["config"], queryFn: () => api("/config"), staleTime: Infinity });
  const acct = cfg.data?.aws_account;
  return (
    <p className="text-[12.5px] text-ink-3">
      Linkler alert'in olduğu zaman aralığına ayarlı açılır. AWS linkleri prod hesabında{acct ? ` (${acct})` : ""} oturum açmış olmanı gerektirir.
      Portal bu sorguları kendisi çalıştırmaz, ek maliyet oluşmaz.
    </p>
  );
}
