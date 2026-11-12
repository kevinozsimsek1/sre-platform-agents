import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RotateCcw, UserRound } from "lucide-react";
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

export function refreshWork(qc: ReturnType<typeof useQueryClient>) {
  ["incidents", "incident", "overview", "team-work"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

/** Atanan işi tamamlandı olarak işaretle ya da geri aç. */
export function DoneButton({ iid, done }: { iid: string; done: boolean }) {
  const qc = useQueryClient();
  const m = useMutation({ mutationFn: () => put(`/incidents/${iid}/done`, { done: !done }), onSuccess: () => refreshWork(qc) });
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); m.mutate(); }} disabled={m.isPending}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12.5px] disabled:opacity-60 ${done ? "border-edge text-ink-3 hover:text-ink" : "border-good/40 bg-good-soft text-good hover:border-good"}`}>
      {done ? <><RotateCcw size={12} /> Geri aç</> : <><Check size={12} /> Tamamlandı</>}
    </button>
  );
}

/** Olayı ekipten birine ata. Liste SRE_TEAM ayarından gelir; boşsa hiç görünmez. */
export function AssignPicker({ iid, a, compact = false }: { iid: string; a?: Assignee | null; compact?: boolean }) {
  const team = useTeam();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (to: string | null) => put(`/incidents/${iid}/assignee`, { to }),
    onSuccess: () => refreshWork(qc),
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
      {!compact && a && !m.isPending && <DoneButton iid={iid} done={!!a.done_at} />}
      {m.error && <span className="text-[12px] text-crit">{(m.error as Error).message}</span>}
    </label>
  );
}
