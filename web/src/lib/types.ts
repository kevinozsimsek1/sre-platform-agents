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
  after_change?: boolean; after_related_change?: boolean; assignee?: Assignee | null;
};
export type Assignee = { to: string; at: number; done_at?: number | null; title?: string; more?: number; severity?: string | null; start?: number | null };
export type WorkItem = Assignee & { id: string; known: boolean; ongoing: boolean; minutes: number | null; end: number | null };
export type Work = {
  fetched_at: number;
  people: { name: string; open: WorkItem[]; done: WorkItem[]; done_total: number }[];
  unassigned: { id: string; title: string; more: number; severity: string; start: number; ongoing: boolean; minutes: number }[];
  cost_tasks: CostTask[];
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
  fix: Fix | null;
};

/** Grafana sorgularının AWS'ye çıkardığı maliyet. */
export type CostRule = {
  org: number; uid: string; title: string; group: string;
  every_s: number; every_known: boolean; evals_month: number;
  metric_queries: number; expands: number; math: number; metric_cost_month: number; uncertain: boolean;
  metrics_per_eval?: number; load_month?: number;
  real_metrics_month: number | null; real_cost_month: number | null;
  logs: { window_min: number; groups: string[]; overlap: number | null }[];
};
export type CostQuery = { kind: "metric" | "logs"; text: string; period_s: number | null; metrics: number | null; expands: boolean; math: boolean; tips: string[] };
export type CostWidget = {
  title: string; type: string | null; repeat: boolean; panel_id?: number | null;
  metrics_per_refresh?: number;
  metric_queries: number; logs_queries: number; expands: number; math: number;
  queries: CostQuery[];
  real_metrics_month: number | null; real_cost_month: number | null;
};
export type CostDashboard = {
  org: number; uid: string; title: string; folder: string;
  refresh: string | null; every_s: number | null; panels: number; hidden_panels: number;
  cloudwatch_metric: number; cloudwatch_logs: number; prometheus: number; other: number; unknown: number;
  expands: number; math: number; repeats: number; uncertain: boolean;
  metrics_per_refresh?: number;
  cost_month_if_open: number; url: string; settings_url?: string;
  load_month: number; real_metrics_month: number | null; real_cost_month: number | null;
  widgets: CostWidget[];
};
export type BillItem = { usage_type: string; label: string; what: string; cost: number; quantity: number };
export type Bill =
  | { available: false; reason: string }
  | {
      available: true; fetched_at: number; account: string | null; service: string;
      months: { start: string; end: string; partial: boolean; total: number; items: BillItem[] }[];
      last_full: { start: string; end: string; partial: boolean; total: number; items: BillItem[] };
      current: { start: string; end: string; partial: boolean; total: number; items: BillItem[] };
      gmd: { cost: number; quantity: number };
      scanned: { cost: number; quantity: number };
      ingest: { cost: number; quantity: number };
    };
export type Attribution = {
  available: boolean;
  real_metrics_month: number; real_cost_month: number; usd_per_metric: number;
  rule_load_month: number; dashboard_load_month: number; total_load_month: number;
  rule_metrics_month: number | null; dashboard_metrics_month: number | null;
  rule_cost_month: number | null; dashboard_cost_month: number | null;
  rule_share: number | null; load_vs_billed: number | null; measured: boolean;
  period: string | null;
};

/** Tamamlanan iyileştirmeler ve kazandırdıkları. */
export type Savings = {
  done: { id: string; title: string; kind: string | null; to: string | null; done_at: number;
          saving_usd: number | null; months_since: number; accrued_usd: number; still_fixed: boolean }[];
  count: number; monthly_usd: number; accrued_usd: number;
  regressed: { id: string; title: string }[];
  first_done_at: number | null; open_potential_usd: number;
};
/** Maliyet bulgusundan türeyen, kişiye atanabilir iyileştirme görevi. */
export type CostTask = {
  id: string; kind: string; severity: "crit" | "warn" | "info";
  title: string; fix: string; why: string;
  saving_usd: number | null; current_usd: number | null; saving_note: string;
  where: string; links: { label: string; url: string }[]; math?: string[];
  assignee: { to: string; at: number; done_at?: number | null; title?: string } | null;
};

export type QueryCost = {
  fetched_at: number;
  bill: Bill;
  attribution: Attribution;
  tasks: CostTask[];
  savings: Savings;
  team: string[];
  price: { metric_per_1k: number; logs_per_gb: number };
  summary: {
    rules: number; rule_metric_cost_month: number; log_rules: number; log_rule_scans_month: number; worst_overlap: number;
    dashboards: number; dashboards_cw: number; dashboards_fast: number; dashboard_cost_month_if_all_open: number;
    uncertain_rules: number; uncertain_dashboards: number; hidden_panels: number; unknown_targets: number; expanding_targets: number;
  };
  rules: CostRule[];
  log_rules: CostRule[];
  dashboards: CostDashboard[];
};

/** Bulgulardan türetilen uygulanabilir değişiklikler. Portal bunları uygulamaz, sadece hazırlar. */
export type FixChange = { field: string; label: string; from: string | number | boolean | null; to: string | number | boolean | null; code: string; why: string };
export type Fix = {
  changes: FixChange[];
  manual: { code: string; what: string }[];
  rule: Record<string, unknown> | null;
  uid: string; org: number;
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
  trend_detail?: { month: SloRates; week: SloRates; by: "slow" | "errors" } | null;
};
export type SloRates = { slow: number; errors: number };
export type SloLogs = { group?: string; group_url?: string; errors: string; error_counts?: string; all: string };
export type SloList = {
  fetched_at: number; window_days: number; min_requests: number;
  default: { availability: number; latency_ms: number; latency_target: number };
  services: SloService[];
};

export type ChangeItem = {
  namespace: string; deployment: string; replicaset?: string;
  /** release: image değişti · rollback: eski bir ReplicaSet'e dönüldü · new: deployment prod'a ilk kez çıktı · restart: aynı image · unknown: image bilgisi yok */
  kind: "release" | "rollback" | "new" | "restart" | "unknown";
  version: string | null; prev_version: string | null;
  /** Önceki sürümün başlangıcı; exact=false ise görünen en eski kayıt ("en az … beri") */
  prev_since_ms?: number | null; prev_since_exact?: boolean | null;
  t_ms: number;
};
export type ChangeBatch = {
  id: string; start: number; end: number; deployments: number; releases: number; restarts: number; rollbacks?: number; new?: number; mass: boolean;
  items: ChangeItem[]; incidents_after?: Incident[]; minutes_before?: number; related?: boolean;
};
export type Changes = {
  fetched_at: number;
  window_days: number;
  stats: { releases: number; restarts: number; rollbacks: number; new: number; unknown: number; batches: number; mass: number; deployments: number };
  batches: ChangeBatch[];
  schedules: { time: string; deployments: number; days: number; names: string[] }[];
  /** Şu an en yeni ReplicaSet'ini değil daha eskisini çalıştıran deployment'lar (geri alınmış durumda) */
  rolled_back: { namespace: string; deployment: string; running: string[]; newest: string }[];
  correlation: { incidents: number; after_change: number; since: number | null };
};

/** Log gruplarının alım ve saklama maliyeti. */
export type LogGroupCost = {
  name: string; stored_gb: number; retention_days: number | null; class: string;
  ingest_gb: number; ingest_usd: number; storage_usd: number; total_usd: number; flags: string[];
};
export type LogCost =
  | { available: false; reason: string; bill?: Bill }
  | {
      available: true; fetched_at: number; window_days: number;
      rates: { ingest_usd_per_gb: number; storage_usd_per_gb_month: number; scan_usd_per_gb?: number };
      summary: {
        groups: number; ingest_gb: number; ingest_usd: number; stored_gb: number; storage_usd: number;
        no_retention: number; no_retention_gb: number; dead: number; dead_gb: number; top10_share: number;
      };
      groups: LogGroupCost[];
      no_retention: string[];
      dead: { name: string; stored_gb: number }[];
      bill: Bill;
    };

/** Bir log grubunun içinde ne olduğu: kısa örnek pencere taranıp bileşene göre kırılır. */
export type LogBreakdown =
  | { available: false; reason: string }
  | {
      available: true; group: string; minutes: number; fetched_at: number;
      full: boolean; scale_factor: number;
      sample_mb: number; projected_month_gb: number; streams: number;
      scan_gb: number; scan_usd: number;
      parts: { name: string; share: number; sample_mb: number; lines: number; streams: number; month_gb: number; month_usd: number }[];
    };

/** Kimsenin bakmadığı maliyet: hesap ve bölge taraması + "bu kullanılıyor mu" kanıtı. */
export type IdleContent = { label: string; value: string };

export type IdleResource = {
  kind: "ec2" | "ebs" | "nat" | "eip" | "ipv4" | "elb" | "ecs" | "rds" | "snapshot" | "hata";
  id: string; name: string; region: string; account: string;
  detail?: string | null; vpc?: string | null; since?: string | null;
  usd_month: number; flags: string[];
  evidence?: string | null; note?: string | null; basis?: string | null;
  contents?: IdleContent[];
};

export type IdleRegion = {
  region: string; usd_last_full: number; usd_current: number; swept: boolean;
  items: { usage_type: string; cost: number; qty: number }[];
};

export type IdleAccount = {
  label: string; account: string | null; month: string; current_month: string;
  usd_last_full: number; other_regions_usd: number; home_region: string;
  regions: IdleRegion[]; resources: IdleResource[];
};

export type Idle =
  | { available: false; reason: string; errors?: { label: string; reason: string }[] }
  | {
      available: true; fetched_at: number; window_days: number;
      accounts: IdleAccount[];
      errors: { label: string; reason: string }[];
      summary: {
        accounts: number; regions: number; usd_last_full: number;
        away_regions: number; away_usd: number;
        away: { account: string; region: string; usd: number }[];
        flagged: number; flagged_usd: number;
      };
    };
