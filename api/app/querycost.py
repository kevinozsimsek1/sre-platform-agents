"""Grafana'daki sorguların AWS'ye çıkardığı maliyet.

İki ayrı şey ölçülür, çünkü maliyet davranışları bambaşka:
  - Alert kuralları 7/24 çalışır. Maliyeti kimse bakmasa da birikir.
  - Dashboard'lar yalnızca açıkken sorgu atar. Maliyeti "açık kaldığı sürece" cinsindendir.

CloudWatch metrik sorgusunun fiyatı sorgu sayısından kesin hesaplanabilir (GetMetricData, 1000 metrik başına).
Logs Insights taranan bayt başına ücretlendirilir; portalın AWS erişimi olmadığı için bayt tahmin edilmez.
Onun yerine yapısal israf ölçülür: sorgu penceresi değerlendirme aralığından kaç kat uzun (aynı veri kaç kez
yeniden taranıyor) ve kaç log grubuna bakılıyor.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from . import config, cwmetrics, grafana

MONTH_S = 30 * 86400
REFRESH_S = {"5s": 5, "10s": 10, "15s": 15, "30s": 30, "1m": 60, "5m": 300, "10m": 600, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "1d": 86400}


def _refresh_seconds(v: Any) -> int | None:
    if not isinstance(v, str):
        return None
    return REFRESH_S.get(v.strip())


def _targets(panel: dict) -> list[dict]:
    return panel.get("targets") or []


def _flatten(panels: list[dict] | None) -> list[dict]:
    out: list[dict] = []
    for p in panels or []:
        if p.get("type") == "row":
            out += _flatten(p.get("panels"))
        else:
            out.append(p)
    return out


def _split_rows(panels: list[dict] | None) -> tuple[list[dict], int]:
    """Açık panelleri ve çökmüş satırların içinde kalan panel sayısını ayırır.

    Çökmüş (collapsed) satırdaki panel, satır açılmadan sorgu atmaz; maliyete katmak yanlış olur.
    """
    live: list[dict] = []
    hidden = 0
    for p in panels or []:
        if p.get("type") == "row":
            inner = _flatten(p.get("panels"))
            if p.get("collapsed"):
                hidden += len(inner)
            else:
                live += inner
        else:
            live.append(p)
    return live, hidden


def _is_metric_request(t: dict) -> bool:
    """AWS'den gerçekten metrik isteyen hedef mi?

    Yalnızca metric math olan hedef (expression var, metricName yok) kendi başına metrik istemez;
    ücret, ifadenin referans verdiği sorgulardan işler.
    """
    if not t.get("metricName"):
        return False
    return bool(t.get("namespace"))


def _period_s(t: dict) -> int | None:
    p = t.get("period")
    try:
        return int(str(p).rstrip("s")) if p not in (None, "", "auto") else None
    except ValueError:
        return None


def _dims(t: dict) -> str:
    d = t.get("dimensions") or {}
    if not d:
        return ""
    out = []
    for k, v in d.items():
        out.append(f"{k}={','.join(v) if isinstance(v, list) else v}")
    return " · ".join(out)


def _query_text(t: dict) -> str:
    """Panelde ne sorulduğunun insan okunur hali."""
    if _kind(t) == "logs":
        return (t.get("expression") or "").strip()
    if t.get("metricName"):
        base = f"{t.get('namespace', '?')} / {t['metricName']} ({t.get('statistic') or t.get('statistics') or 'Average'})"
        d = _dims(t)
        return f"{base}  [{d}]" if d else f"{base}  [boyut yok]"
    if t.get("expression"):
        return f"metric math: {t['expression']}"
    return t.get("refId") or "—"


def _tips(t: dict, every_s: int | None) -> list[str]:
    """Bu hedef için somut iyileştirme önerileri."""
    tips: list[str] = []
    if _kind(t) == "logs":
        return tips
    if str(t.get("metricQueryType")) == "1":
        tips.append("Search tipi sorgu: eşleşen her metrik ayrı ücretlenir. Gerekli metrikleri tek tek seçmek maliyeti öngörülebilir yapar.")
    if t.get("matchExact") is False:
        tips.append("matchExact kapalı: sorgu beklenenden fazla metriğe açılıyor. Açmak, yalnızca tam eşleşen metriği getirir.")
    dims = t.get("dimensions") or {}
    if not dims:
        tips.append("Boyut (dimension) tanımlı değil: namespace'teki bütün kaynaklar çekiliyor. İlgilenilen kaynağı boyutla sınırlamak gerekir.")
    elif any(v == "*" or (isinstance(v, list) and ("*" in v or len(v) > 1)) for v in dims.values()):
        tips.append("Boyutta joker ya da çoklu değer var: her değer ayrı metrik demek. Panel başına tek kaynak daha ucuzdur.")
    p = _period_s(t)
    if p is not None and p < 300:
        tips.append(f"Period {p} sn: veri noktası sayısı period küçüldükçe artar. 300 sn, metrik başına istenen veriyi belirgin düşürür.")
    if every_s and every_s <= 30:
        tips.append(f"Dashboard {every_s} saniyede bir yenileniyor: bu panelin sorgusu da aynı sıklıkta tekrar gidiyor.")
    return tips


def _expands(t: dict) -> bool:
    """Tek hedef birden çok metriğe açılabilir mi? (o zaman ücret sorgu sayısından fazla olur)"""
    if str(t.get("metricQueryType")) == "1":      # Search tipi
        return True
    if t.get("matchExact") is False:
        return True
    dims = t.get("dimensions") or {}
    if not dims:                                   # boyut yok: kaynak ayrımı yapılmıyor
        return True
    for v in dims.values():
        if v == "*" or (isinstance(v, list) and ("*" in v or len(v) > 1)):
            return True
    return False


def _ds_type(ref: Any, types: dict[str, str], by_name: dict[str, str]) -> str:
    """Panel ya da hedefin veri kaynağı tipi. Şablon değişkeni (${ds}) ise bilinmez."""
    if isinstance(ref, dict):
        if ref.get("type"):
            return str(ref["type"])
        uid = ref.get("uid")
    else:
        uid = ref
    if not isinstance(uid, str) or uid.startswith("$"):
        return "?"
    return types.get(uid) or by_name.get(uid) or "?"


def _kind(model: dict) -> str:
    return "logs" if str(model.get("queryMode", "")).lower() == "logs" else "metric"


def _log_groups(model: dict) -> list[str]:
    gs = model.get("logGroups")
    if isinstance(gs, list) and gs:
        out = []
        for g in gs:
            arn = g.get("arn") if isinstance(g, dict) else None
            name = (g.get("name") if isinstance(g, dict) else None) or (arn.split(":log-group:")[-1] if arn else None)
            if name:
                out.append(name.rstrip(":*"))
        return out
    names = model.get("logGroupNames")
    return [str(n) for n in names] if isinstance(names, list) else []


async def _org(org: int) -> dict[str, Any]:
    ds = await grafana.get("/api/datasources", org)
    types = {d["uid"]: d["type"] for d in ds}
    by_name = {d["name"]: d["type"] for d in ds}

    rules_raw, ruler = await asyncio.gather(
        grafana.get("/api/v1/provisioning/alert-rules", org),
        grafana.get("/api/prometheus/grafana/api/v1/rules", org),
    )
    interval: dict[tuple[str, str], int] = {}
    for g in (ruler.get("data") or {}).get("groups", []):
        if g.get("interval"):
            interval[(g.get("file", ""), g.get("name", ""))] = int(g["interval"])
    default_interval = min(interval.values()) if interval else 60

    found = await grafana.get("/api/search", org, {"type": "dash-db", "limit": 5000})
    got = await asyncio.gather(*[grafana.get(f"/api/dashboards/uid/{s['uid']}", org) for s in found], return_exceptions=True)

    # Bir sorgunun kaç metriğe açıldığını CloudWatch'a sorup ölç (ücretsiz, sonuç önbelleklenir)
    probe: list[dict] = []
    for r in rules_raw:
        if r.get("isPaused"):
            continue
        for dd in r.get("data", []):
            if _ds_type({"uid": dd.get("datasourceUid")}, types, by_name) == "cloudwatch":
                m = dd.get("model") or {}
                if _kind(m) == "metric" and _is_metric_request(m):
                    probe.append(m)
    for res in got:
        if isinstance(res, BaseException):
            continue
        for p in _split_rows((res.get("dashboard") or {}).get("panels"))[0]:
            for t in _targets(p):
                if _ds_type(t.get("datasource") or p.get("datasource"), types, by_name) == "cloudwatch":
                    if _kind(t) == "metric" and _is_metric_request(t):
                        probe.append(t)
    counts = await cwmetrics.resolve(probe)

    def n_metrics(t: dict) -> int:
        """Bu hedefin AWS'den istediği metrik sayısı. Ölçülemezse 1 kabul edilir (alt sınır)."""
        return cwmetrics.count_for(t, counts) or 1

    rules: list[dict[str, Any]] = []
    for r in rules_raw:
        if r.get("isPaused"):
            continue
        group = r.get("ruleGroup", "")
        found_interval = next((v for (f, n), v in interval.items() if n == group), None)
        every = found_interval or default_interval
        evals = MONTH_S / every if every else 0
        metric_q = expands = math = 0
        metrics_each = 0
        logs: list[dict[str, Any]] = []
        for d in r.get("data", []):
            if _ds_type({"uid": d.get("datasourceUid")}, types, by_name) != "cloudwatch":
                continue
            model = d.get("model") or {}
            if _kind(model) == "logs":
                win = float((d.get("relativeTimeRange") or {}).get("from") or 0)
                logs.append({"window_min": round(win / 60, 1), "groups": _log_groups(model),
                             "overlap": round(win / every, 1) if every else None})
            elif _is_metric_request(model):
                metric_q += 1
                metrics_each += n_metrics(model)
                if _expands(model):
                    expands += 1
            else:
                math += 1
        if not metric_q and not logs:
            continue
        rules.append({
            "org": org, "uid": r.get("uid"), "title": r.get("title"), "group": group,
            "every_s": every, "every_known": found_interval is not None, "evals_month": int(evals),
            "metric_queries": metric_q, "expands": expands, "math": math,
            "metrics_per_eval": metrics_each,
            "metric_cost_month": round(metrics_each * evals / 1000 * config.CW_METRIC_USD_PER_1K, 2) if metric_q else 0.0,
            "uncertain": bool(expands) or found_interval is None,
            "logs": logs,
        })

    dashboards: list[dict[str, Any]] = []
    for s, res in zip(found, got):
        if isinstance(res, BaseException):
            continue
        dash = res.get("dashboard") or {}
        every = _refresh_seconds(dash.get("refresh"))
        panels, hidden = _split_rows(dash.get("panels"))
        cnt = {"cloudwatch_metric": 0, "cloudwatch_logs": 0, "prometheus": 0, "other": 0, "unknown": 0}
        expands = 0   # çoğalabilen hedef: gerçek metrik sayısı sorgu sayısından fazla olur
        math = 0      # yalnızca metric math: kendi başına metrik istemez
        repeats = 0   # şablon değişkeniyle çoğaltılan panel
        widgets: list[dict[str, Any]] = []
        for p in panels:
            if p.get("repeat"):
                repeats += 1
            w_metric = w_logs = w_expands = w_math = w_metrics = 0
            queries: list[dict[str, Any]] = []
            for t in _targets(p):
                typ = _ds_type(t.get("datasource") or p.get("datasource"), types, by_name)
                if typ == "cloudwatch":
                    kind = _kind(t)
                    if kind == "logs":
                        cnt["cloudwatch_logs"] += 1
                        w_logs += 1
                    elif _is_metric_request(t):
                        cnt["cloudwatch_metric"] += 1
                        w_metric += 1
                        w_metrics += n_metrics(t)
                        if _expands(t):
                            expands += 1
                            w_expands += 1
                    else:
                        math += 1
                        w_math += 1
                    queries.append({"kind": kind, "text": _query_text(t), "period_s": _period_s(t),
                                    "metrics": cwmetrics.count_for(t, counts) if (kind == "metric" and _is_metric_request(t)) else None,
                                    "expands": kind == "metric" and _is_metric_request(t) and _expands(t),
                                    "math": kind == "metric" and not _is_metric_request(t),
                                    "tips": _tips(t, every)})
                elif typ == "prometheus":
                    cnt["prometheus"] += 1
                elif typ == "?":
                    cnt["unknown"] += 1
                else:
                    cnt["other"] += 1
            if w_metric or w_logs or w_math:
                widgets.append({
                    "title": p.get("title") or f"(adsız {p.get('type', 'panel')})", "type": p.get("type"),
                    "panel_id": p.get("id"),
                    "repeat": bool(p.get("repeat")),
                    "metric_queries": w_metric, "logs_queries": w_logs, "expands": w_expands, "math": w_math,
                    "metrics_per_refresh": w_metrics,
                    "queries": queries,
                })
        widgets.sort(key=lambda w: (-w["metric_queries"], -w["logs_queries"]))
        cw = cnt["cloudwatch_metric"]
        dash_metrics = sum(w["metrics_per_refresh"] for w in widgets)
        dashboards.append({
            "org": org, "uid": s.get("uid"), "title": dash.get("title") or s.get("title"), "folder": s.get("folderTitle") or "",
            "refresh": dash.get("refresh") or None, "every_s": every, "panels": len(panels), "hidden_panels": hidden, **cnt,
            "metrics_per_refresh": dash_metrics,
            "expands": expands, "math": math, "repeats": repeats, "widgets": widgets,
            # Açıkken, tek izleyici için alt sınır: çoğalan hedefler ve repeat yüzünden gerçek tutar daha yüksek olabilir
            "cost_month_if_open": round(dash_metrics * (MONTH_S / every) / 1000 * config.CW_METRIC_USD_PER_1K, 2) if (every and cw) else 0.0,
            "uncertain": bool(expands or repeats or cnt["unknown"]),
            "url": f"{config.GRAFANA_URL}/d/{s.get('uid')}?orgId={org}",
            # Doğrudan düzeltilecek yere açan bağlantılar
            "settings_url": f"{config.GRAFANA_URL}/d/{s.get('uid')}?orgId={org}&editview=settings",
        })
    return {"rules": rules, "dashboards": dashboards, "measured": bool(counts)}


def _attribute(rules: list[dict], dashboards: list[dict], bill: dict | None) -> dict[str, Any]:
    """Gerçek faturadaki metrik sorgusu kalemini ölçülen sorgu yüküne göre paylaştırır.

    Yöntem (sunumda anlatılabilir olması için basit tutuldu):
      1. Toplam tutar ve metrik sayısı AWS faturasından okunur; tahmin değildir.
      2. Her kuralın ve her panelin kaç metrik istediği CloudWatch ListMetrics ile ölçülür,
         değerlendirme/yenileme sıklığıyla çarpılır. Bu, sorgu tanımlarının izin verdiği ÜST SINIR yüktür.
      3. Fatura bu yüke oranla paylaştırılır. Yani tutarlar "payı" gösterir; sıralama ölçüme dayanır.

    Ölçülen üst sınır, faturalanan metrik sayısından yüksek çıkar: Grafana sorgu anında tam eşleşme
    ve gruplama yaptığı için tanımların eşleşebileceği her metriği istemez. Bu oran sayfada gösterilir.
    """
    for r in rules:
        r["load_month"] = r.get("metrics_per_eval", r["metric_queries"]) * r["evals_month"]
    for d in dashboards:
        per = d.get("metrics_per_refresh") or d["cloudwatch_metric"]
        d["load_month"] = int(per * (MONTH_S / d["every_s"])) if (d["every_s"] and per) else 0

    rule_load = sum(r["load_month"] for r in rules)
    dash_load = sum(d["load_month"] for d in dashboards)
    total_load = rule_load + dash_load

    real_metrics = float((bill or {}).get("gmd", {}).get("quantity") or 0)
    real_cost = float((bill or {}).get("gmd", {}).get("cost") or 0)
    per_metric = (real_cost / real_metrics) if real_metrics else 0.0

    def money(load: float) -> float | None:
        if not total_load or not real_cost:
            return None
        return round(real_cost * load / total_load, 2)

    def metrics(load: float) -> int | None:
        if not total_load or not real_metrics:
            return None
        return int(real_metrics * load / total_load)

    for r in rules:
        r["real_metrics_month"] = metrics(r["load_month"])
        r["real_cost_month"] = money(r["load_month"])
    for d in dashboards:
        d["real_metrics_month"] = metrics(d["load_month"])
        d["real_cost_month"] = money(d["load_month"])
        base = (d.get("metrics_per_refresh") or d["cloudwatch_metric"]) or 1
        for w in d["widgets"]:
            w_share = (w.get("metrics_per_refresh") or w["metric_queries"]) / base
            w["real_metrics_month"] = int((d["real_metrics_month"] or 0) * w_share) if d["real_metrics_month"] else None
            w["real_cost_month"] = round((d["real_cost_month"] or 0) * w_share, 2) if d["real_cost_month"] else None

    return {
        "available": bool(real_metrics),
        "real_metrics_month": int(real_metrics), "real_cost_month": round(real_cost, 2),
        "usd_per_metric": per_metric,
        "rule_load_month": int(rule_load), "dashboard_load_month": int(dash_load), "total_load_month": int(total_load),
        "rule_metrics_month": metrics(rule_load), "dashboard_metrics_month": metrics(dash_load),
        "rule_cost_month": money(rule_load), "dashboard_cost_month": money(dash_load),
        "rule_share": round(rule_load / total_load, 3) if total_load else None,
        # Ölçülen üst sınır, faturalanan metrik sayısının kaç katı
        "load_vs_billed": round(total_load / real_metrics, 1) if real_metrics else None,
        "period": (bill or {}).get("last_full", {}).get("start"),
    }


async def overview(bill: dict | None = None) -> dict[str, Any]:
    orgs = await asyncio.gather(*[_org(o) for o in config.GRAFANA_ORGS], return_exceptions=True)
    rules: list[dict] = []
    dashboards: list[dict] = []
    measured = False
    for res in orgs:
        if isinstance(res, BaseException):
            continue
        rules += res["rules"]
        dashboards += res["dashboards"]
        measured = measured or res.get("measured", False)
    attribution = _attribute(rules, dashboards, bill if (bill or {}).get("available") else None)
    rules.sort(key=lambda r: (-(r.get("real_cost_month") or r["metric_cost_month"]), -len(r["logs"])))
    dashboards.sort(key=lambda d: -(d.get("real_cost_month") or d["cost_month_if_open"]))
    log_rules = [r for r in rules if r["logs"]]
    attribution["measured"] = measured
    return {
        "attribution": attribution,
        "bill": bill or {"available": False, "reason": "Fatura okunmadı."},
        "fetched_at": int(time.time() * 1000),
        "price": {"metric_per_1k": config.CW_METRIC_USD_PER_1K, "logs_per_gb": config.CW_LOGS_USD_PER_GB},
        "summary": {
            "rules": len(rules),
            "rule_metric_cost_month": round(sum(r["metric_cost_month"] for r in rules), 2),
            "log_rules": len(log_rules),
            "log_rule_scans_month": sum(r["evals_month"] * len(r["logs"]) for r in log_rules),
            "worst_overlap": max((l["overlap"] or 0 for r in log_rules for l in r["logs"]), default=0),
            "dashboards": len(dashboards),
            "dashboards_cw": sum(1 for d in dashboards if d["cloudwatch_metric"] or d["cloudwatch_logs"]),
            "dashboards_fast": sum(1 for d in dashboards if d["every_s"] and d["every_s"] <= 30),
            "dashboard_cost_month_if_all_open": round(sum(d["cost_month_if_open"] for d in dashboards), 2),
            # Rakamın ne kadarına güvenilebileceğini söyleyen sayaçlar
            "uncertain_rules": sum(1 for r in rules if r["uncertain"]),
            "uncertain_dashboards": sum(1 for d in dashboards if d["uncertain"]),
            "hidden_panels": sum(d["hidden_panels"] for d in dashboards),
            "unknown_targets": sum(d["unknown"] for d in dashboards),
            "expanding_targets": sum(d["expands"] for d in dashboards) + sum(r["expands"] for r in rules),
        },
        "rules": rules,
        "log_rules": log_rules,
        "dashboards": dashboards,
    }
