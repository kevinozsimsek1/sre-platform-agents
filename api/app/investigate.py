"""Bir alert için "nereden bakarım?" rehberi: o zaman aralığına ayarlı Grafana Explore sorguları,
AWS konsolu linkleri, kubectl komutları ve alert ailesine göre ipuçları.

Hiçbir sorgu burada çalıştırılmaz; sadece link üretilir. Linke tıklayan kişi kendi Grafana/AWS
oturumuyla bakar. Bu yüzden ek maliyeti yoktur.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from . import config

REGION = config.AWS_REGION
CONSOLE = "https://console.aws.amazon.com"


# ------------------------------------------------------------- link yardımcıları
def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _aws_enc(s: str) -> str:
    """CloudWatch konsolunun URL kodlaması: harf/rakam dışındaki karakterler *HH olur."""
    return "".join(c if c.isalnum() or c in "-_." else "*" + format(ord(c), "02x") for c in s)


def explore(org: int, ds: dict, model: dict, start: int, end: int) -> str:
    q = {k: v for k, v in model.items() if k not in ("intervalMs", "maxDataPoints")}
    q["refId"] = "A"
    q["datasource"] = {"type": ds["type"], "uid": ds["uid"]}
    panes = {"a": {"datasource": ds["uid"], "queries": [q], "range": {"from": str(start), "to": str(end)}}}
    return f"{config.GRAFANA_URL}/explore?schemaVersion=1&orgId={org}&panes={quote(json.dumps(panes, separators=(',', ':')))}"


def cw_metric(namespace: str, metric: str, dims: dict[str, str], stat: str, start: int, end: int) -> str:
    m = [namespace, metric] + [x for kv in dims.items() for x in kv]
    metrics = "~(~(" + "".join(f"~'{_aws_enc(x)}" for x in m) + "))"
    graph = (f"~(view~'timeSeries~stacked~false~metrics{metrics}~region~'{REGION}~stat~'{_aws_enc(stat or 'Average')}"
             f"~period~60~start~'{_aws_enc(_iso(start))}~end~'{_aws_enc(_iso(end))})")
    return f"{CONSOLE}/cloudwatch/home?region={REGION}#metricsV2?graph={graph}"


def logs_insights(groups: list[str], query: str, start: int, end: int) -> str:
    src = "(" + "".join(f"~'{_aws_enc(g)}" for g in groups) + ")"
    detail = (f"~(end~'{_aws_enc(_iso(end))}~start~'{_aws_enc(_iso(start))}~timeType~'ABSOLUTE~tz~'Local"
              f"~editorString~'{_aws_enc(query)}~source~{src})")
    return f"{CONSOLE}/cloudwatch/home?region={REGION}#logsV2:logs-insights$3FqueryDetail$3D{detail}"


def logs_insights_recent(groups: list[str], query: str, seconds: int = 6 * 3600) -> str:
    """Son N saniyeye ayarlı Logs Insights linki (sayfa ne zaman açılırsa açılsın güncel aralık)."""
    src = "(" + "".join(f"~'{_aws_enc(g)}" for g in groups) + ")"
    detail = (f"~(end~0~start~-{seconds}~timeType~'RELATIVE~unit~'seconds~tz~'Local"
              f"~editorString~'{_aws_enc(query)}~source~{src})")
    return f"{CONSOLE}/cloudwatch/home?region={REGION}#logsV2:logs-insights$3FqueryDetail$3D{detail}"


def log_group_url(group: str) -> str:
    return f"{CONSOLE}/cloudwatch/home?region={REGION}#logsV2:log-groups/log-group/{_aws_enc(group).replace('*', '$25')}"


def route_regex(route: str) -> str:
    r"""ASP.NET route şablonunu log satırında aranacak regex'e çevirir: Orders/{id:guid} -> Orders\/[^\/\s?"]+"""
    out = []
    for part in re.split(r"(\{[^}]*\})", route.strip("/")):
        if part.startswith("{"):
            out.append(r'[^\/\s?"]+')
        elif part:
            out.append(re.sub(r"([.*+?^$()\[\]|\\/])", r"\\\1", part))
    return "".join(out)


ERR_RE = r"(?i)(exception|\berror\b|\bfail|\bfatal\b| 5\d\d )"


def service_logs(group: str, route: str | None = None) -> dict:
    """SLO sayfası için: servisin loglarına (CloudWatch Logs Insights) giden hazır sorgular."""
    head = "fields @timestamp, kubernetes.pod_name as pod, @message"
    tail = "| sort @timestamp desc\n| limit 200"
    if route:
        rx = route_regex(route)
        return {
            "all": logs_insights_recent([group], f"{head}\n| filter @message like /(?i){rx}/\n{tail}"),
            "errors": logs_insights_recent([group], f"{head}\n| filter @message like /(?i){rx}/ and @message like /{ERR_RE}/\n{tail}"),
        }
    return {
        "group": group,
        "group_url": log_group_url(group),
        "errors": logs_insights_recent([group], f"{head}\n| filter @message like /{ERR_RE}/\n{tail}"),
        "error_counts": logs_insights_recent([group], f"filter @message like /{ERR_RE}/\n| stats count(*) as hata by bin(10m)\n| sort bin(10m) desc", 24 * 3600),
        "all": logs_insights_recent([group], f"{head}\n{tail}"),
    }


# ------------------------------------------------------------- rehber
def guide(rule: Any, datasources: dict[str, dict], labels: dict[str, str], start: int, end: int) -> list[dict]:
    """rule: analysis.RuleModel. labels: incelenen serinin etiketleri. start/end: ms (pay eklenmiş)."""
    org = rule.org
    out: list[dict] = []
    links: list[dict] = []
    for d in rule.raw.get("data", []):
        uid = d.get("datasourceUid")
        if uid == "__expr__" or uid not in datasources:
            continue
        ds = {"uid": uid, **datasources[uid]}
        links.append({"label": f"Kuralın sorgusu ({d.get('refId')}) · Grafana Explore", "url": explore(org, ds, d.get("model", {}), start, end), "kind": "grafana"})
    dash, panel = rule.annotations.get("__dashboardUid__"), rule.annotations.get("__panelId__")
    if dash:
        p = f"&viewPanel={panel}" if panel else ""
        links.append({"label": "Bağlı dashboard paneli (aynı zaman aralığı)", "url": f"{config.GRAFANA_URL}/d/{dash}?orgId={org}&from={start}&to={end}{p}", "kind": "grafana"})
    links.append({"label": "Kuralın Grafana'daki geçmişi", "url": f"{config.GRAFANA_URL}/alerting/grafana/{rule.uid}/view?orgId={org}&tab=history", "kind": "grafana"})
    out.append({"title": "Önce buradan bak", "why": "Alert'in kendi sorgusu ve paneli, tam olarak tetiklendiği zaman aralığında.", "links": links, "commands": []})

    models = [d.get("model", {}) for d in rule.raw.get("data", []) if d.get("datasourceUid") != "__expr__"]
    cw = next((m for m in models if m.get("namespace")), None)
    logs = next((m for m in models if m.get("queryMode") == "Logs" or m.get("logGroups") or m.get("logGroupNames")), None)
    prom = next((m for m in models if m.get("expr")), None)
    prom_uid = next((d.get("datasourceUid") for d in rule.raw.get("data", []) if d.get("model", {}).get("expr")), None)

    if cw:
        ns, metric, stat = cw.get("namespace", ""), cw.get("metricName", ""), cw.get("statistic", "Average")
        dims = {}
        for k, v in (cw.get("dimensions") or {}).items():
            val = labels.get(k) or (v[0] if isinstance(v, list) and v and v[0] != "*" else None)
            if val:
                dims[k] = val
        hint = {"title": f"AWS · {ns} / {metric}", "why": "", "links": [], "commands": []}
        if dims:
            hint["links"].append({"label": f"CloudWatch metriği ({', '.join(f'{k}={v}' for k, v in dims.items())})",
                                  "url": cw_metric(ns, metric, dims, stat, start, end), "kind": "aws"})
        fam = family_hint(ns, metric, dims, start, end)
        hint["why"] = fam.pop("why", "")
        hint["links"] += fam.get("links", [])
        hint["commands"] += fam.get("commands", [])
        out.append(hint)

    if logs:
        groups = [g.get("name") or g.get("arn", "").split(":log-group:")[-1].removesuffix(":*") for g in logs.get("logGroups") or []]
        groups += logs.get("logGroupNames") or []
        groups = [g for g in groups if g]
        q = logs.get("expression") or logs.get("queryString") or ""
        if groups and q:
            out.append({"title": "CloudWatch Logs Insights", "why": "Kural log tabanlı. Aynı sorgu aynı aralıkta; satırları tek tek görmek için stats satırını kaldırabilirsin.",
                        "links": [{"label": f"Logs Insights ({', '.join(groups[:2])}{'…' if len(groups) > 2 else ''})", "url": logs_insights(groups, q, start, end), "kind": "aws"}],
                        "commands": []})

    if prom:
        out.append(prom_hint(org, prom.get("expr", ""), labels, datasources, start, end, prom_uid))
    return [h for h in out if h and (h["links"] or h["commands"] or h["why"])]


def family_hint(ns: str, metric: str, dims: dict[str, str], start: int, end: int) -> dict:
    links: list[dict] = []
    cmds: list[str] = []
    why = ""
    if ns == "AWS/Lambda":
        fn = dims.get("FunctionName")
        why = ("Lambda süresi aşıldığında genelde ya girdi büyümüştür ya da çağrılan bir bağımlılık (DB, HTTP) yavaşlamıştır. "
               "Her gün aynı saatte oluyorsa zamanlanmış bir tetikleyici (EventBridge) olabilir.")
        if fn:
            links.append({"label": f"Lambda: {fn} · izleme sekmesi", "url": f"{CONSOLE}/lambda/home?region={REGION}#/functions/{fn}?tab=monitoring", "kind": "aws"})
            q = ('filter @type = "REPORT"\n| stats max(@duration) as max_ms, avg(@duration) as avg_ms, '
                 'max(@maxMemoryUsed/1000/1000) as max_mem_mb, count(*) as calls by bin(5m)')
            links.append({"label": "Logs Insights: süre ve bellek (REPORT satırları)", "url": logs_insights([f"/aws/lambda/{fn}"], q, start, end), "kind": "aws"})
            q2 = "fields @timestamp, @message\n| filter @message like /(?i)(error|timeout|exception)/\n| sort @timestamp desc\n| limit 100"
            links.append({"label": "Logs Insights: aynı aralıktaki hatalar", "url": logs_insights([f"/aws/lambda/{fn}"], q2, start, end), "kind": "aws"})
            links.append({"label": "EventBridge kuralları (zamanlanmış tetikleyici var mı?)", "url": f"{CONSOLE}/events/home?region={REGION}#/rules", "kind": "aws"})
    elif ns == "AWS/RDS":
        db = dims.get("DBClusterIdentifier") or dims.get("DBInstanceIdentifier")
        why = ("RDS gecikmesi çoğunlukla ağır bir sorgu, kilitlenme ya da IOPS sınırından gelir. "
               "Aynı aralıkta Performance Insights'ta en çok bekleyen sorgulara bak.")
        if db:
            links.append({"label": f"RDS: {db}", "url": f"{CONSOLE}/rds/home?region={REGION}#database:id={db};is-cluster={'true' if 'Cluster' in ''.join(dims) else 'false'}", "kind": "aws"})
        links.append({"label": "Performance Insights", "url": f"{CONSOLE}/rds/home?region={REGION}#performance-insights-v20206:", "kind": "aws"})
    elif ns == "AWS/ApplicationELB":
        lb = dims.get("LoadBalancer")
        why = ("ELB kaynaklı 5xx (HTTPCode_ELB_5XX) hedefin yanıt vermediğini ya da sağlıksız olduğunu gösterir; "
               "Target 5xx ise uygulamanın kendisi hata dönüyor. Aynı aralıkta target group sağlığına ve pod restart'larına bak.")
        if lb:
            name = lb.split("/")[1] if "/" in lb else lb
            links.append({"label": f"Load balancer: {name}", "url": f"{CONSOLE}/ec2/home?region={REGION}#LoadBalancers:search={name}", "kind": "aws"})
            links.append({"label": "Target group'lar", "url": f"{CONSOLE}/ec2/home?region={REGION}#TargetGroups:", "kind": "aws"})
    elif ns == "AWS/Kafka":
        why = "Under-replicated partition genelde bir broker'ın geride kalması ya da yeniden başlamasıdır; broker CPU/disk metriklerine bak."
        links.append({"label": "MSK cluster'ları", "url": f"{CONSOLE}/msk/home?region={REGION}#/clusters", "kind": "aws"})
    elif ns == "AWS/SQS":
        q = dims.get("QueueName")
        why = "DLQ'ya düşen mesaj, tüketicinin mesajı işleyemediği anlamına gelir. Mesajın gövdesine ve tüketici loglarına bak."
        if q:
            links.append({"label": f"SQS: {q}", "url": f"{CONSOLE}/sqs/v3/home?region={REGION}#/queues", "kind": "aws"})
    elif ns == "AWS/ApiGateway":
        why = "API Gateway hatalarında önce hangi path'in hata verdiğine, sonra entegrasyonun (Lambda/servis) loguna bak."
    return {"why": why, "links": links, "commands": cmds}


def prom_hint(org: int, expr: str, labels: dict[str, str], dss: dict[str, dict], start: int, end: int, rule_ds: str | None = None) -> dict:
    prom_uid = rule_ds if rule_ds in dss else next((u for u, d in dss.items() if d["type"] == "prometheus" and "prod" in d["name"].lower()), None)
    links: list[dict] = []
    cmds: list[str] = []
    why = ""
    ns, pod, svc = labels.get("namespace"), labels.get("pod"), labels.get("service_name") or labels.get("job", "").split("/")[-1] or None
    env = labels.get("env", "prod")
    ctx = {"prod": "nebim-prod", "dev": "nebim-dev"}.get(env, f"<{env}-context>")

    def ex(label: str, q: str) -> None:
        if prom_uid:
            links.append({"label": label, "url": explore(org, {"uid": prom_uid, **dss[prom_uid]}, {"expr": q, "editorMode": "code", "range": True}, start, end), "kind": "grafana"})

    if "http_client_request" in expr:
        why = "Dışarıya giden (outbound) çağrılar. Hangi hedefin (server_address) yavaşladığını ya da hata verdiğini bul; sorun genelde tek bir entegrasyondadır."
        ex("Hedef bazında p95 gecikme", "topk(10, histogram_quantile(0.95, sum by (le, server_address) (rate(http_client_request_duration_seconds_bucket[5m]))))")
        ex("Hedef bazında 5xx", 'topk(10, sum by (server_address) (rate(http_client_request_duration_seconds_count{http_response_status_code=~"5.."}[5m])))')
        ex("Hangi servis çağırıyor", "topk(10, sum by (service_name, server_address) (rate(http_client_request_duration_seconds_count[5m])))")
    elif "http_server_request" in expr:
        why = "Servise gelen istekler. Hangi route'un hata ya da gecikme ürettiğini bul, sonra o aralıktaki trace'lere bak."
        ex("Endpoint bazında 5xx", 'topk(10, sum by (service_name, http_route) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m])))')
    elif "kube_pod" in expr:
        reason = labels.get("reason")
        why = {"ImagePullBackOff": "Image çekilemiyor: tag yanlış, image silinmiş ya da registry yetkisi yok.",
               "CrashLoopBackOff": "Container başlayıp çöküyor: önceki çalışmanın loguna (--previous) bak.",
               "CreateContainerConfigError": "Eksik ConfigMap/Secret ya da hatalı env tanımı."}.get(reason or "", "Pod çalışmıyor; event'lere ve container loguna bak.")
        if ns and pod:
            cmds += [f"kubectl --context {ctx} -n {ns} describe pod {pod}",
                     f"kubectl --context {ctx} -n {ns} get events --sort-by=.lastTimestamp | tail -20",
                     f"kubectl --context {ctx} -n {ns} logs {pod} --all-containers --previous --tail=100"]
        ex("Namespace'teki bekleyen container'lar", f'sum by (pod, container, reason) (kube_pod_container_status_waiting_reason{{namespace="{ns}"}})' if ns else "sum by (namespace, reason) (kube_pod_container_status_waiting_reason)")
    tempo_uid = config.TEMPO_DS_UID or next((u for u, d in dss.items() if d["type"] == "tempo" and "prod" in d["name"].lower()), None) \
        or next((u for u, d in dss.items() if d["type"] == "tempo"), None)
    if svc and tempo_uid:
        tq = f'{{resource.service.name="{svc}" && status=error}}'
        links.append({"label": f"Tempo: {svc} hatalı trace'ler", "url": explore(org, {"uid": tempo_uid, "type": "tempo"}, {"queryType": "traceql", "query": tq, "limit": 20}, start, end), "kind": "grafana"})
    return {"title": "Metrik ve trace ipuçları", "why": why, "links": links, "commands": cmds}
