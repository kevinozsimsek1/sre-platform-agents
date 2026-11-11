import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2, Sparkles, Wrench } from "lucide-react";
import { api, post } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { Panel, Pill } from "./ui";

type AgentInfo = { id: string; label: string; description: string };
type Result = { agent: string; started: number; status: "ok" | "error"; text?: string; error?: string; tools?: string[]; seconds?: number; by?: string | null; question?: string | null };
type State = { items: Result[]; running: { agent: string; started: number } | null };

type Props = {
  kind: "incident" | "rule" | "slo";
  refId: string;
  agents: AgentInfo[];
  suggestion?: { agent: string; reason: string };
  initial?: State;
  episode?: { start: number; series: string } | null;
  title?: string;
};

/** "Agent ile araştır": bağlamı portal toplar, seçilen (ya da önerilen) agent'a yollar, cevabı burada saklar. */
export default function AgentPanel({ kind, refId, agents, suggestion, initial, episode, title = "Agent ile araştır" }: Props) {
  const qc = useQueryClient();
  const [agent, setAgent] = useState<string>(suggestion?.agent ?? agents[0]?.id ?? "cloudwatch");
  const [question, setQuestion] = useState("");
  useEffect(() => { if (suggestion?.agent) setAgent(suggestion.agent); }, [suggestion?.agent]);

  const key = ["investigation", kind, refId];
  const q = useQuery<State>({
    queryKey: key,
    queryFn: () => api(`/investigations/${kind}/${encodeURIComponent(refId).replace(/%3A/g, ":")}`),
    initialData: initial,
    refetchInterval: (query) => (query.state.data?.running ? 3000 : false),
  });

  const run = useMutation({
    mutationFn: () => post("/investigations", {
      kind, ref: refId, agent, question: question.trim() || null,
      episode_start: episode?.start ?? null, episode_series: episode?.series ?? null,
    }),
    onSuccess: () => { setQuestion(""); qc.invalidateQueries({ queryKey: key }); },
  });

  const running = q.data?.running;
  const label = (id: string) => agents.find((a) => a.id === id)?.label ?? id;

  return (
    <Panel className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><Sparkles size={18} /></span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-[13px] text-ink-2">
            Portal alert'in bağlamını (sorgu, eşik, seriler, zaman aralığı, bulgular) toplayıp agent'a gönderir. Agent'lar GPU node açıkken çalışır.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Agent">
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={agent === a.id}
              onClick={() => setAgent(a.id)}
              className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] ${agent === a.id ? "border-accent bg-accent-soft text-accent" : "border-edge text-ink-2 hover:text-ink"}`}
              title={a.description}
            >
              <Bot size={14} /> {a.label}
              {suggestion?.agent === a.id && <span className="rounded bg-panel px-1.5 text-[10.5px] font-semibold text-accent">önerilen</span>}
            </button>
          ))}
        </div>
        {suggestion && <p className="text-[12.5px] text-ink-3">{suggestion.reason}</p>}
        {episode && <p className="text-[12.5px] text-ink-2">Odak: {episode.series} · {fmtDateTime(episode.start)} tetiklenmesi</p>}
        <label className="sr-only" htmlFor={`q-${kind}-${refId}`}>Ek soru</label>
        <textarea
          id={`q-${kind}-${refId}`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="İstersen ek soru yaz (ör. 'Bu Lambda'yı tetikleyen EventBridge kuralı hangisi?')"
          className="w-full resize-y rounded-md border border-edge bg-canvas px-3 py-2 text-sm placeholder:text-ink-3"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!!running || run.isPending}
            onClick={() => run.mutate()}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            data-audit={`Agent ile araştır (${kind})`}
          >
            {running || run.isPending ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {running ? `${label(running.agent)} araştırıyor…` : `${label(agent)} ile araştır`}
          </button>
          {run.error && <span className="text-[13px] text-crit">{(run.error as Error).message}</span>}
        </div>
      </div>

      {(q.data?.items ?? []).length > 0 && (
        <div className="flex flex-col gap-3 border-t border-edge-soft pt-3">
          {q.data!.items.map((r) => (
            <article key={r.started} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3">
                <Pill tone={r.status === "ok" ? "good" : "crit"}>{r.status === "ok" ? "tamamlandı" : "hata"}</Pill>
                <span>{label(r.agent)}</span>·<span>{fmtDateTime(r.started)}</span>
                {r.seconds != null && <><span>·</span><span>{r.seconds} sn</span></>}
                {r.by && <><span>·</span><span>{r.by}</span></>}
              </div>
              {r.question && <p className="text-[13px] text-ink-2">Soru: {r.question}</p>}
              {r.status === "ok" ? (
                <div className="rounded-md bg-canvas px-3.5 py-3 text-[14px] leading-relaxed whitespace-pre-wrap">{r.text}</div>
              ) : (
                <div className="rounded-md bg-crit-soft px-3.5 py-2.5 text-[13.5px] text-crit">{r.error}</div>
              )}
              {r.tools && r.tools.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                  <Wrench size={12} /> {r.tools.join(", ")}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
