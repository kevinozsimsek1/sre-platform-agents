import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { api, put } from "../lib/api";
import type { Assignee } from "../lib/types";
import { ago } from "../lib/format";

type Cfg = { team: string[] };

export function useTeam(): string[] {
  const q = useQuery<Cfg>({ queryKey: ["config"], queryFn: () => api("/config"), staleTime: 10 * 60_000 });
  return q.data?.team ?? [];
}

/** Olayın kimde olduğunu gösteren küçük etiket. */
export function AssigneeTag({ a }: { a?: Assignee | null }) {
  if (!a) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[12px] font-medium text-accent" title={`${ago(a.at)} atandı`}>
      <UserRound size={12} /> {a.to}
    </span>
  );
}

/** Olayı ekipten birine ata. Liste SRE_TEAM ayarından gelir; boşsa hiç görünmez. */
export function AssignPicker({ iid, a, compact = false }: { iid: string; a?: Assignee | null; compact?: boolean }) {
  const team = useTeam();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (to: string | null) => put(`/incidents/${iid}/assignee`, { to }),
    onSuccess: () => ["incidents", "incident", "overview"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
  if (!team.length) return null;
  const value = m.isPending ? (m.variables ?? "") : (a?.to ?? "");
  return (
    <label className={`inline-flex items-center gap-2 ${compact ? "text-[12.5px]" : "text-[13.5px]"}`} onClick={(e) => e.stopPropagation()}>
      {!compact && <span className="text-ink-2">Kimde:</span>}
      <select
        value={value}
        disabled={m.isPending}
        onChange={(e) => m.mutate(e.target.value || null)}
        aria-label="Olayı ata"
        className={`rounded-md border px-2 py-1 ${value ? "border-accent/50 bg-accent-soft font-medium text-accent" : "border-edge bg-canvas text-ink-2"}`}
      >
        <option value="">{compact ? "atanmadı" : "kimseye atanmadı"}</option>
        {team.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      {!compact && a && !m.isPending && <span className="text-[12px] text-ink-3">{ago(a.at)}</span>}
      {m.error && <span className="text-[12px] text-crit">{(m.error as Error).message}</span>}
    </label>
  );
}
