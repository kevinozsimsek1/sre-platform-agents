import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtNum, fmtPct } from "../lib/format";
import { CopyLine } from "../components/Investigate";
import { Bar, Empty, ErrorBox, Freshness, Loading, PageHeader, Panel, Pill, Section, Stat, td, tdn, th, thr, type Tone } from "../components/ui";

type Cmds = { cmds: string[] };
type Node = Cmds & { node: string; ready: boolean; pressure: string[]; cpu_used: number | null; mem_used: number | null; cpu_requested: number | null; mem_requested: number | null; pods: number; pods_max: number | null };
type Pod = Cmds & { namespace: string; pod: string; problems: { kind: string; detail: string }[]; restarts_24h: number };
type Workload = Cmds & { kind: string; namespace: string; name: string; missing: number; note?: string };
type Ns = { namespace: string; cpu_used: number; cpu_requested: number; mem_used: number; mem_requested: number };
type Resp = {
  fetched_at: number;
  summary: { nodes: number; nodes_ready: number; problem_pods: number; restarting_pods: number; workloads: number; jobs_failed: number; certs_soon: number; pvcs_full: number };
  nodes: Node[]; pods: Pod[]; workloads: Workload[];
  jobs: (Cmds & { namespace: string; name: string; failed: number })[];
  certs: { namespace: string; name: string; days: number }[];
  pvcs: { namespace: string; name: string; used: number }[];
  namespaces: Ns[];
};

const short = (n: string) => n.split(".")[0];
const gb = (b: number) => `${(b / 2 ** 30).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} GB`;
const cores = (c: number) => `${c.toLocaleString("tr-TR", { maximumFractionDigits: 2 })} çekirdek`;
const tone = (x: number | null, warn = 0.75, crit = 0.9): "good" | "warn" | "crit" | "accent" => x == null ? "accent" : x >= crit ? "crit" : x >= warn ? "warn" : "accent";

const PROBLEM: Record<string, { tone: Tone; label: string }> = {
  CrashLoopBackOff: { tone: "crit", label: "CrashLoopBackOff" },
  OOMKilled: { tone: "crit", label: "bellek yetmedi (OOM)" },
  ImagePullBackOff: { tone: "crit", label: "image çekilemiyor" },
  ErrImagePull: { tone: "crit", label: "image çekilemiyor" },
  CreateContainerConfigError: { tone: "crit", label: "config hatası" },
  Pending: { tone: "warn", label: "Pending (yer bulamadı)" },
  Failed: { tone: "crit", label: "Failed" },
  Unknown: { tone: "warn", label: "durumu bilinmiyor" },
  Restart: { tone: "mute", label: "restart" },
};

function Usage({ v, label }: { v: number | null; label?: string }) {
  if (v == null) return <span className="text-ink-3">—</span>;
  return (
    <div className="flex min-w-28 flex-col gap-1">
      <span className="font-mono text-[12.5px] tabular-nums">{fmtPct(v, 0)}{label && <span className="text-ink-3"> {label}</span>}</span>
      <Bar value={v} tone={tone(v)} />
    </div>
  );
}

function Cmd({ c }: { c: Cmds }) {
  return <div className="flex flex-col gap-1">{c.cmds.map((x) => <CopyLine key={x} cmd={x} />)}</div>;
}

export default function Cluster() {
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ["cluster"], queryFn: () => api("/cluster"), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading label="Prometheus'tan cluster durumu okunuyor" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const s = d.summary;
  const noCpuReq = d.namespaces.filter((n) => n.cpu_requested === 0 && n.cpu_used > 0);
  const overMem = d.namespaces.filter((n) => n.mem_requested > 0 && n.mem_used > n.mem_requested * 1.2);

  return (
    <>
      <PageHeader eyebrow="Altyapı" title="Cluster durumu"
        actions={<Freshness at={d.fetched_at} busy={q.isFetching} onRefresh={() => qc.fetchQuery({ queryKey: ["cluster"], queryFn: () => api("/cluster?refresh=true") })} />}>
        <p className="max-w-[78ch] text-[15px] text-ink-2">
          Prod EKS'in şu anki hali: sorunlu pod'lar, node doluluğu, eksik replikalar, süresi dolacak sertifikalar ve dolan diskler.
          Alert gelmesini beklemeden ya da kubectl açmadan bakmak için. Her dakika yenilenir.
        </p>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={`${s.nodes_ready}/${s.nodes}`} label="node hazır" tone={s.nodes_ready < s.nodes ? "crit" : "good"} />
        <Stat value={s.problem_pods} label="sorunlu pod" tone={s.problem_pods ? "crit" : "good"} hint={`${s.restarting_pods} pod son 24 saatte restart attı`} />
        <Stat value={s.workloads + s.jobs_failed} label="eksik replika / başarısız job" tone={s.workloads + s.jobs_failed ? "warn" : "good"} />
        <Stat value={s.certs_soon + s.pvcs_full} label="sertifika (<21 gün) / dolu disk (%80+)" tone={s.certs_soon + s.pvcs_full ? "warn" : "good"} />
      </div>

      <Section title="Sorunlu pod'lar" aside="Şu an çalışmayanlar ve son 24 saatte restart atanlar">
        {d.pods.length === 0 ? <Empty>Sorunlu pod yok, son 24 saatte restart atan da yok.</Empty> : (
          <Panel className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-[13.5px]">
              <thead><tr><th className={th}>Pod</th><th className={th}>Sorun</th><th className={thr}>Restart (24 sa)</th><th className={th}>Bakmak için</th></tr></thead>
              <tbody className="divide-y divide-edge-soft">
                {d.pods.map((p) => (
                  <tr key={p.namespace + p.pod}>
                    <td className={td}><div className="font-medium break-all">{p.pod}</div><div className="text-[12px] text-ink-3">{p.namespace}</div></td>
                    <td className={td}>
                      <div className="flex flex-wrap gap-1">
                        {p.problems.map((x, i) => <Pill key={i} tone={(PROBLEM[x.kind] ?? { tone: "warn" as Tone }).tone}>{PROBLEM[x.kind]?.label ?? x.kind}</Pill>)}
                      </div>
                      {p.problems.some((x) => x.detail) && <div className="mt-1 text-[12px] text-ink-3">{p.problems.map((x) => x.detail).filter(Boolean).join(" · ")}</div>}
                    </td>
                    <td className={tdn}>{p.restarts_24h || "—"}</td>
                    <td className={td + " w-[420px]"}><Cmd c={p} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </Section>

      {(d.workloads.length > 0 || d.jobs.length > 0) && (
        <Section title="Eksik replikalı iş yükleri ve başarısız job'lar">
          <Panel className="divide-y divide-edge-soft">
            {d.workloads.map((w) => (
              <div key={w.kind + w.namespace + w.name} className="grid gap-2 p-3.5 md:grid-cols-[1fr_420px]">
                <div>
                  <div className="flex flex-wrap items-center gap-2"><Pill tone="warn">{w.kind}</Pill><span className="font-medium">{w.name}</span><span className="text-[12px] text-ink-3">{w.namespace}</span></div>
                  <div className="mt-1 text-[13px] text-ink-2">{w.note ?? `${w.missing} replika hazır değil`}</div>
                </div>
                <Cmd c={w} />
              </div>
            ))}
            {d.jobs.map((j) => (
              <div key={j.namespace + j.name} className="grid gap-2 p-3.5 md:grid-cols-[1fr_420px]">
                <div className="flex flex-wrap items-center gap-2"><Pill tone="crit">Job</Pill><span className="font-medium">{j.name}</span><span className="text-[12px] text-ink-3">{j.namespace} · {j.failed} başarısız</span></div>
                <Cmd c={j} />
              </div>
            ))}
          </Panel>
        </Section>
      )}

      <Section title="Node'lar" aside="Kullanılan: gerçek tüketim · Ayrılan: pod'ların istediği (request)">
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[13.5px]">
            <thead><tr>
              <th className={th}>Node</th><th className={th}>Durum</th><th className={th}>CPU kullanılan</th><th className={th}>CPU ayrılan</th>
              <th className={th}>Bellek kullanılan</th><th className={th}>Bellek ayrılan</th><th className={thr}>Pod</th>
            </tr></thead>
            <tbody className="divide-y divide-edge-soft">
              {d.nodes.map((n) => (
                <tr key={n.node}>
                  <td className={td}><span className="font-mono text-[12.5px]" title={n.node}>{short(n.node)}</span></td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-1">
                      {n.ready ? <Pill tone="good">hazır</Pill> : <Pill tone="crit">hazır değil</Pill>}
                      {n.pressure.map((p) => <Pill key={p} tone="crit">{p}</Pill>)}
                    </div>
                  </td>
                  <td className={td}><Usage v={n.cpu_used} /></td>
                  <td className={td}><Usage v={n.cpu_requested} /></td>
                  <td className={td}><Usage v={n.mem_used} /></td>
                  <td className={td}><Usage v={n.mem_requested} /></td>
                  <td className={tdn}>{n.pods}{n.pods_max ? <span className="text-ink-3"> / {n.pods_max}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </Section>

      <Section title="Namespace bazında ayrılan ve kullanılan kaynak" aside="Kullanım son 30 dakika ortalaması">
        {(noCpuReq.length > 0 || overMem.length > 0) && (
          <Panel className="flex flex-col gap-1.5 border-warn/40 bg-warn-soft/40 p-4 text-[14px]">
            {noCpuReq.length > 0 && (
              <p><b className="font-semibold">CPU isteği tanımlı değil:</b> {noCpuReq.map((n) => n.namespace).join(", ")}. Bu pod'lar node'a yerleşirken CPU hesaba katılmıyor;
                yoğunlukta aynı node'daki diğer servisleri yavaşlatabilir. Deployment'lara <code className="font-mono text-[13px]">resources.requests.cpu</code> eklenmeli.</p>
            )}
            {overMem.length > 0 && (
              <p><b className="font-semibold">Bellek isteğinin üstünde çalışıyor:</b> {overMem.map((n) => `${n.namespace} (${gb(n.mem_used)} / istenen ${gb(n.mem_requested)})`).join(", ")}.
                Node dolarsa önce bu pod'lar tahliye edilir (evict). İstek gerçek kullanıma göre artırılmalı.</p>
            )}
          </Panel>
        )}
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead><tr><th className={th}>Namespace</th><th className={thr}>CPU kullanılan</th><th className={thr}>CPU ayrılan</th><th className={thr}>Bellek kullanılan</th><th className={thr}>Bellek ayrılan</th></tr></thead>
            <tbody className="divide-y divide-edge-soft">
              {d.namespaces.map((n) => (
                <tr key={n.namespace}>
                  <td className={td + " font-medium"}>{n.namespace}</td>
                  <td className={tdn}>{cores(n.cpu_used)}</td>
                  <td className={tdn}>{n.cpu_requested ? cores(n.cpu_requested) : <span className="text-warn">tanımsız</span>}</td>
                  <td className={tdn}>{gb(n.mem_used)}</td>
                  <td className={tdn}>{n.mem_requested ? <span className={n.mem_used > n.mem_requested * 1.2 ? "text-warn" : ""}>{gb(n.mem_requested)}</span> : <span className="text-warn">tanımsız</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Sertifikalar" aside="cert-manager">
          {d.certs.length === 0 ? <Empty>cert-manager sertifikası bulunamadı.</Empty> : (
            <Panel className="divide-y divide-edge-soft">
              {d.certs.map((c) => (
                <div key={c.namespace + c.name} className="flex items-center gap-3 p-3.5">
                  <div className="min-w-0 flex-1"><div className="truncate font-medium">{c.name}</div><div className="text-[12px] text-ink-3">{c.namespace}</div></div>
                  <Pill tone={c.days < 7 ? "crit" : c.days < 21 ? "warn" : "good"}>{fmtNum(Math.floor(c.days))} gün kaldı</Pill>
                </div>
              ))}
            </Panel>
          )}
        </Section>
        <Section title="Diskler (PVC)">
          {d.pvcs.length === 0 ? <Empty>PVC bulunamadı.</Empty> : (
            <Panel className="divide-y divide-edge-soft">
              {d.pvcs.map((p) => (
                <div key={p.namespace + p.name} className="flex items-center gap-3 p-3.5">
                  <div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name}</div><div className="text-[12px] text-ink-3">{p.namespace}</div></div>
                  <div className="w-36"><Usage v={p.used} label="dolu" /></div>
                </div>
              ))}
            </Panel>
          )}
        </Section>
      </div>
    </>
  );
}
