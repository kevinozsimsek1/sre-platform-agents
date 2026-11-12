import type { GuideItem } from "../components/Investigate";

export type FindingRef = { code: string; level: "crit" | "warn" | "info" };
export type Finding = FindingRef & { title: string; detail: string; suggestion: string; impact: { errors: number; fires: number } };
export type RuleRef = { key: string; org: number; uid: string; title: string; severity: string | null };

export type RuleRow = {
  key: string; org: number; uid: string; title: string; folder: string; group: string;
  severity: string | null; for: string; paused: boolean; state: string; health: string | null;
  fires: number; short: number; median: number | null; offhours: number; errors: number; nodata: number;
  findings: FindingRef[]; last_fired: number | null; active: number;
};

export type Summary = {
  fetched_at: number;
  window: { start: number; end: number; days: number };
  totals: {
    rules: number; paused: number; silent: number; fires: number; errors: number; incidents: number;
    short_pct: number; offhours_pct: number; top5_pct: number; firing_now: number; rules_with_findings: number; preventable_fires: number;
  };
  daily: { day: string; fires: number; errors: number }[];
  hours: number[];
  findings: (Finding & { rule: RuleRef })[];
  rules: RuleRow[];
};

export type Episode = { start: number; end: number | null; minutes: number; series: string; value: string; rule: { key: string; title: string }; offhours: boolean };

export type Incident = {
  id: string; start: number; end: number | null; ongoing: boolean; minutes: number; severity: "critical" | "warning" | "none";
  rules: RuleRef[]; episodes: number; series: number; offhours: boolean; night: boolean; preventable: boolean; analyses?: number;
  after_change?: boolean; after_related_change?: boolean;
};

export type AgentInfo = { id: string; label: string; description: string };
export type AgentState = { items: any[]; running: { agent: string; started: number } | null };
export type Query = { ref: string; condition: boolean; kind: string; text?: string; range?: string };

export type RuleDetail = {
  rule: RuleRow & { labels: Record<string, string>; annotations: Record<string, string>; exec_err_state: string | null; no_data_state: string | null; last_error: string | null; nearmiss: number };
  links: { grafana: string; panel: string | null };
  routing: { name: string; type: string }[];
  queries: Query[];
  findings: Finding[];
  active: { labels: Record<string, string>; state: string; since: string; value: string }[];
  daily: { day: string; fires: number; errors: number }[];
  hours: number[];
  durations: { label: string; count: number }[];
  p50: number | null; p90: number | null;
  series: { series: string; fires: number; minutes: number; last: number }[];
  errors: { message: string; count: number }[];
  episodes: Episode[];
  incidents: Incident[];
  investigate: GuideItem[];
  analysis: AgentState; agents: AgentInfo[]; agent_suggestion: { agent: string; reason: string };
};

export type IncidentDetail = Incident & {
  timeline: Episode[];
  findings: (Finding & { rule: string })[];
  routing: Record<string, { name: string; type: string }[]>;
  rules_detail: (RuleRow & { queries: Query[]; annotations: Record<string, string> })[];
  investigate: { rule: string; key: string; guide: GuideItem[] }[];
  analysis: AgentState; agents: AgentInfo[]; agent_suggestion: { agent: string; reason: string };
  changes: ChangeBatch[];
};

export type SloTarget = { availability: number; latency_ms: number; latency_target: number; source: "tanımlı" | "varsayılan"; owner: string | null; note: string | null; approx: boolean };
export type SloMeasured = { requests: number; errors_5xx: number; slow: number; availability: number; latency: number };
export type SloService = {
  service: string; target: SloTarget; measured: SloMeasured | null;
  status: "breached" | "at_risk" | "ok" | "low_traffic"; trend: "better" | "worse" | "same" | null; explain: string | null;
  allowed: { slow: number; errors: number };
  suggested?: { availability?: number; latency_ms?: number; latency_target?: number };  // sadece yönetim ekranında gelir
  p99_ms: number | null; p95_ms: number | null;
};
export type SloList = {
  fetched_at: number; window_days: number; min_requests: number;
  default: { availability: number; latency_ms: number; latency_target: number };
  services: SloService[];
};

export type ChangeItem = { namespace: string; deployment: string; kind: "release" | "restart" | "unknown"; version: string | null; prev_version: string | null; t_ms: number };
export type ChangeBatch = {
  id: string; start: number; end: number; deployments: number; releases: number; restarts: number; mass: boolean;
  items: ChangeItem[]; incidents_after?: Incident[]; minutes_before?: number; related?: boolean;
};
export type Changes = {
  fetched_at: number;
  stats: { releases: number; restarts: number; batches: number; mass: number; deployments: number };
  batches: ChangeBatch[];
  schedules: { time: string; deployments: number; days: number; names: string[] }[];
  correlation: { incidents: number; after_change: number; since: number | null };
};
