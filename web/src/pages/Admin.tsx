import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, LogOut, Search } from "lucide-react";
import { api, post } from "../lib/api";
import { fmtFull } from "../lib/format";
import { Empty, ErrorBox, Loading, PageHeader, Panel, Pill, Stat, td, th, type Tone } from "../components/ui";
import AdminTargets from "./AdminTargets";

type Me = { admin: boolean; configured: boolean; user: string };
type Ev = { ts: number; kind: string; action: string; ip: string; user: string | null; visitor: string | null; ua: string; status?: number; ms?: number; page?: string; detail?: string | null; question?: string | null; agent?: string | null; target?: string; query?: string | null };
type Log = {
  total: number; matched: number;
  stats: { events_24h: number; people_24h: number; ips: number; failed_logins: number; agent_questions: number };
  people: { name: string; events: number }[];
  events: Ev[];
};

const KIND: Record<string, { label: string; tone: Tone }> = {
  page_view: { label: "sayfa", tone: "mute" },
  click: { label: "tıklama", tone: "mute" },
  action: { label: "işlem", tone: "accent" },
  api: { label: "API", tone: "mute" },
  agent: { label: "agent sorusu", tone: "accent" },
  agent_ui: { label: "agent arayüzü", tone: "mute" },
  admin: { label: "admin", tone: "warn" },
  team: { label: "ekip", tone: "accent" },
};

const ACTIONS: Record<string, string> = {
  login_ok: "Yönetime giriş yaptı",
  login_failed: "Hatalı şifreyle giriş denedi",
  login_blocked: "Çok fazla hatalı deneme, engellendi",
  slo_target_changed: "Servis hedefini değiştirdi",
  incident_assigned: "Olayı atadı",
  work_done: "İşi tamamlandı yaptı",
  work_reopened: "İşi geri açtı",
};

function browser(ua: string): string {
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl/.test(ua) ? "curl" : ua.split(" ")[0] || "?";
  return os ? `${b} · ${os}` : b;
}

function Login() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (v: { username: string; password: string }) => post("/admin/login", v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
  });
  return (
    <Panel className="mx-auto mt-6 flex w-full max-w-sm flex-col gap-4 p-6">
      <div className="flex items-center gap-2.5"><LockKeyhole size={18} className="text-ink-2" /><h2 className="font-semibold">Denetim kaydı</h2></div>
      <p className="text-[13.5px] text-ink-2">Bu alan sadece portal yöneticisine açık. Giriş denemeleri de kayda geçer.</p>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); m.mutate({ username: String(f.get("u")), password: String(f.get("p")) }); }}>
        <label className="flex flex-col gap-1 text-[13px]">Kullanıcı adı<input id="admin-u" name="u" autoComplete="username" defaultValue="root" className="rounded-md border border-edge bg-canvas px-3 py-2 text-sm" /></label>
        <label className="flex flex-col gap-1 text-[13px]">Şifre<input id="admin-p" name="p" type="password" autoComplete="current-password" className="rounded-md border border-edge bg-canvas px-3 py-2 text-sm" /></label>
        {m.error && <p className="text-[13px] text-crit">{(m.error as Error).message}</p>}
        <button type="submit" disabled={m.isPending} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">Giriş yap</button>
      </form>
    </Panel>
  );
}

function Logs() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"audit" | "targets">("audit");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [hours, setHours] = useState(24);
  const [hideApi, setHideApi] = useState(true);
  const params = new URLSearchParams({ limit: "1000", ...(q ? { q } : {}), ...(kind ? { kind } : {}), ...(hours ? { hours: String(hours) } : {}) });
  const logs = useQuery<Log>({ queryKey: ["audit", q, kind, hours], queryFn: () => api(`/admin/audit?${params}`), refetchInterval: 15000 });
  const logout = useMutation({ mutationFn: () => post("/admin/logout", {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }) });

  const events = (logs.data?.events ?? []).filter((e) => !hideApi || kind || e.kind !== "api");
  return (
    <>
      <PageHeader eyebrow="Sadece yönetici" title="Yönetim"
        actions={<button type="button" onClick={() => logout.mutate()} className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-panel px-2.5 py-1 text-[13px] text-ink-2 hover:text-ink"><LogOut size={13} /> Çıkış</button>}>
        <div className="flex gap-1 rounded-md bg-edge-soft p-1 w-fit" role="tablist">
          {([["audit", "Denetim kaydı"], ["targets", "Servis hedefleri"]] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`rounded px-3 py-1 text-[13px] ${tab === k ? "bg-panel font-medium text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}>{l}</button>
          ))}
        </div>
        {tab === "audit" && <p className="max-w-[80ch] text-[14px] text-ink-2">
          Portalda ve agent arayüzlerinde ne zaman, hangi IP ve tarayıcıdan, ne yapıldığı. Her tarayıcıya otomatik ve anonim bir kimlik atanır; aynı kimlik aynı tarayıcıdır.
          Port-forward ile girildiğinde IP 127.0.0.1 görünür; portal bir iç adrese açılınca gerçek IP'ler görünür.
        </p>}
      </PageHeader>

      {tab === "targets" ? <AdminTargets /> : logs.isLoading ? <Loading /> : logs.error ? <ErrorBox error={logs.error} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat value={logs.data!.stats.events_24h} label="kayıt (24 saat)" />
            <Stat value={logs.data!.stats.people_24h} label="farklı tarayıcı (24 saat)" />
            <Stat value={logs.data!.stats.agent_questions} label="agent'a sorulan soru" />
            <Stat value={logs.data!.stats.ips} label="farklı IP" />
            <Stat value={logs.data!.stats.failed_logins} label="hatalı admin girişi" tone={logs.data!.stats.failed_logins ? "warn" : undefined} />
          </div>

          <div className="flex flex-wrap gap-2">
            {logs.data!.people.map((p) => (
              <button key={p.name} type="button" onClick={() => setQ(p.name.split(" · ")[0])} className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[12.5px] text-ink-2 hover:text-ink">
                {p.name} <span className="font-mono text-ink-3">{p.events}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-60 flex-1 items-center gap-2 rounded-md border border-edge bg-panel px-2.5 py-1.5 text-sm">
              <Search size={15} className="text-ink-3" />
              <input id="audit-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="IP, tarayıcı kimliği, sayfa, soru…" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-3" />
            </label>
            <select id="audit-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border border-edge bg-panel px-2.5 py-1.5 text-sm">
              <option value="">Tüm türler</option>
              {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select id="audit-hours" value={hours} onChange={(e) => setHours(+e.target.value)} className="rounded-md border border-edge bg-panel px-2.5 py-1.5 text-sm">
              <option value={1}>Son 1 saat</option><option value={24}>Son 24 saat</option><option value={168}>Son 7 gün</option><option value={0}>Tümü</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-ink-2"><input id="audit-api" type="checkbox" checked={hideApi} onChange={(e) => setHideApi(e.target.checked)} /> API çağrılarını gizle</label>
          </div>

          <Panel className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-[13px]">
              <thead><tr><th className={th}>Zaman</th><th className={th}>IP</th><th className={th}>Tarayıcı</th><th className={th}>Tür</th><th className={th}>Ne yaptı</th><th className={th}>Ayrıntı</th></tr></thead>
              <tbody className="divide-y divide-edge-soft">
                {events.map((e, i) => (
                  <tr key={i}>
                    <td className={td + " whitespace-nowrap font-mono text-[12px] text-ink-2"}>{fmtFull(e.ts)}</td>
                    <td className={td + " font-mono text-[12px]"}>{e.ip}</td>
                    <td className={td + " max-w-[200px]"}>
                      <span className="font-mono text-[12px]">{e.visitor?.slice(0, 8) ?? "—"}</span>
                      <div className="truncate text-[11px] text-ink-3" title={e.ua}>{browser(e.ua)}</div>
                    </td>
                    <td className={td}><Pill tone={KIND[e.kind]?.tone ?? "mute"}>{KIND[e.kind]?.label ?? e.kind}</Pill></td>
                    <td className={td + " max-w-[320px] break-words"}>
                      {ACTIONS[e.action] ?? e.action}
                      {e.status && e.status >= 400 && <span className="ml-1 text-crit">({e.status})</span>}
                    </td>
                    <td className={td + " max-w-[360px] break-words text-ink-2"}>
                      {e.question ? <>“{e.question}”{e.agent && <span className="text-ink-3"> → {e.agent}</span>}</> : e.target ? <>{e.target}{e.kind === "team" && e.detail && <span className="text-ink-3"> · {e.detail}</span>}</> : e.detail ?? e.page ?? e.query ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {events.length === 0 && <div className="p-4"><Empty>Bu filtreyle kayıt yok.</Empty></div>}
          </Panel>
          <p className="text-[12.5px] text-ink-3">{logs.data!.matched} / {logs.data!.total} kayıt eşleşti · 15 saniyede bir yenilenir</p>
        </>
      )}
    </>
  );
}

export default function Admin() {
  const me = useQuery<Me>({ queryKey: ["admin"], queryFn: () => api("/admin/me") });
  if (me.isLoading) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} />;
  if (!me.data!.configured) {
    return (
      <Panel className="p-5 text-[14px] text-ink-2">
        Admin şifresi henüz tanımlı değil. Kurulum adımı: <code className="font-mono">python -m app.audit hash</code> ile hash üretip
        <code className="font-mono"> sre-portal-admin</code> secret'ına <code className="font-mono">ADMIN_PASSWORD_HASH</code> olarak koy.
      </Panel>
    );
  }
  return me.data!.admin ? <Logs /> : <Login />;
}
