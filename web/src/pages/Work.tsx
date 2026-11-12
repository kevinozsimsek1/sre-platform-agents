import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Work as W, WorkItem } from "../lib/types";
import { ago, fmtDateTime, fmtMin } from "../lib/format";
import { AssignPicker, DoneButton } from "../components/Team";
import { Empty, ErrorBox, Loading, PageHeader, Panel, Pill, Section, Severity } from "../components/ui";

const KEY = "sre-portal:work-person";
const load = () => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } };
const save = (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* yoksa olmasın */ } };

function State({ w }: { w: Pick<WorkItem, "ongoing" | "known" | "minutes"> }) {
  if (!w.known) return <Pill tone="mute">30 günden eski</Pill>;
  return w.ongoing ? <Pill tone="crit">alarm sürüyor · {fmtMin(w.minutes)}</Pill> : <Pill tone="mute">alarm kapandı</Pill>;
}

function Item({ w }: { w: WorkItem }) {
  const body = (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Severity value={w.severity} />
        <span className="min-w-0 truncate font-medium">{w.title}{!!w.more && <span className="text-ink-3"> +{w.more}</span>}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
        <State w={w} />
        <span>{fmtDateTime(w.start)} başladı</span>
        <span>· {w.done_at ? `${ago(w.done_at)} tamamlandı` : `${ago(w.at)} atandı`}</span>
      </div>
    </div>
  );
  return (
    <div className="flex items-start gap-3 p-3.5">
      {w.known ? <Link to={`/incidents/${w.id}`} className="flex min-w-0 flex-1 hover:text-accent">{body}</Link> : body}
      <DoneButton iid={w.id} done={!!w.done_at} />
    </div>
  );
}

export default function Work() {
  const q = useQuery<W>({ queryKey: ["team-work"], queryFn: () => api("/team/work"), refetchInterval: 60_000 });
  const [person, setPerson] = useState(load);
  const [showDone, setShowDone] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  if (!d.people.length) return <Empty>Ekip listesi tanımlı değil (SRE_TEAM ayarı boş).</Empty>;
  const pick = (v: string) => { setPerson(v); save(v); };
  const shown = person ? d.people.filter((p) => p.name === person) : d.people;
  const openTotal = d.people.reduce((n, p) => n + p.open.length, 0);

  return (
    <>
      <PageHeader eyebrow="Ekip" title="Atanan işler">
        <p className="max-w-[76ch] text-[15px] text-ink-2">
          Kimde hangi olay var, ne bitti. Olay, olay sayfasından ya da olaylar listesinden birine atanır; iş bitince "Tamamlandı" denir.
          Atamalar 90 gün saklanır, her değişiklik denetim kaydına düşer.
        </p>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-1.5">
        {[{ name: "", label: `Herkes (${openTotal})` }, ...d.people.map((p) => ({ name: p.name, label: `${p.name} (${p.open.length})` }))].map((x) => (
          <button key={x.name || "all"} type="button" onClick={() => pick(x.name)}
            className={`rounded-full border px-3 py-1 text-[13px] ${person === x.name ? "border-accent bg-accent-soft font-medium text-accent" : "border-edge text-ink-2 hover:text-ink"}`}>
            {x.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Tamamlananları göster
        </label>
      </div>

      {d.unassigned.length > 0 && (
        <Section title="Kimseye atanmamış açık olaylar" aside={`${d.unassigned.length} olay`}>
          <Panel className="divide-y divide-edge-soft border-crit/30">
            {d.unassigned.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center gap-3 p-3.5">
                <Link to={`/incidents/${u.id}`} className="flex min-w-0 flex-1 flex-col gap-1 hover:text-accent">
                  <div className="flex items-center gap-2"><Severity value={u.severity} /><span className="truncate font-medium">{u.title}{!!u.more && <span className="text-ink-3"> +{u.more}</span>}</span></div>
                  <span className="text-[12px] text-ink-3">{fmtDateTime(u.start)} başladı · {fmtMin(u.minutes)} sürüyor</span>
                </Link>
                <AssignPicker iid={u.id} a={null} compact />
              </div>
            ))}
          </Panel>
        </Section>
      )}

      <div className={`grid gap-4 ${person ? "" : "lg:grid-cols-2"}`}>
        {shown.map((p) => (
          <Panel key={p.name} className="flex flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-edge-soft px-4 py-3">
              <span className="text-[15px] font-semibold">{p.name}</span>
              <span className="text-[12.5px] text-ink-3">{p.open.length} açık · {p.done_total} tamamlanan</span>
            </div>
            {p.open.length === 0 ? <p className="p-4 text-[13.5px] text-ink-3">Üzerinde açık iş yok.</p> : (
              <div className="divide-y divide-edge-soft">{p.open.map((w) => <Item key={w.id} w={w} />)}</div>
            )}
            {showDone && p.done.length > 0 && (
              <>
                <div className="border-t border-edge-soft px-4 pt-3 text-[11px] font-semibold tracking-wider text-ink-3 uppercase">Tamamlananlar</div>
                <div className="divide-y divide-edge-soft opacity-75">{p.done.map((w) => <Item key={w.id} w={w} />)}</div>
              </>
            )}
          </Panel>
        ))}
      </div>
    </>
  );
}
