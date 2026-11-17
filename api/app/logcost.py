"""Log gruplarının maliyeti: hangi grup ne kadar üretiyor, ne kadar saklanıyor.

Faturanın en büyük kalemi log alımı. Buradaki iki soru aksiyon üretir:
  - Hangi grup çok log yazıyor? (log seviyesi düşürülür ya da gereksiz log kapatılır)
  - Hangi grupta saklama süresi tanımsız? (sonsuza kadar tutulur, disk maliyeti birikir)

Birim fiyat uydurulmaz: gerçek faturadan türetilir (tutar ÷ miktar). Böylece gösterilen tutar
AWS'nin o ay fiilen uyguladığı orana dayanır.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from . import config

GB = 1_000_000_000
LOOKBACK_DAYS = 30
CHUNK = 450          # GetMetricData tek çağrıda en fazla 500 sorgu alır
MAX_GROUPS = 1200


def _session():
    import boto3

    return boto3.Session(profile_name=config.COST_AWS_PROFILE) if config.COST_AWS_PROFILE else boto3.Session()


def _describe(logs) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for page in logs.get_paginator("describe_log_groups").paginate():
        for g in page.get("logGroups", []):
            out.append({
                "name": g["logGroupName"],
                "stored_gb": round((g.get("storedBytes") or 0) / GB, 3),
                "retention_days": g.get("retentionInDays"),
                "class": g.get("logGroupClass") or "STANDARD",
            })
            if len(out) >= MAX_GROUPS:
                return out
    return out


def _ingest(cw, names: list[str], days: int) -> dict[str, float]:
    """Son N günde her log grubuna yazılan bayt (AWS/Logs IncomingBytes)."""
    end = int(time.time())
    start = end - days * 86400
    out: dict[str, float] = {}
    for i in range(0, len(names), CHUNK):
        batch = names[i:i + CHUNK]
        queries = [{
            "Id": f"m{j}",
            "MetricStat": {
                "Metric": {"Namespace": "AWS/Logs", "MetricName": "IncomingBytes",
                           "Dimensions": [{"Name": "LogGroupName", "Value": n}]},
                "Period": days * 86400, "Stat": "Sum",
            },
            "ReturnData": True,
        } for j, n in enumerate(batch)]
        token = None
        collected: dict[str, float] = {}
        while True:
            kw: dict[str, Any] = {"MetricDataQueries": queries,
                                  "StartTime": start, "EndTime": end, "ScanBy": "TimestampDescending"}
            if token:
                kw["NextToken"] = token
            res = cw.get_metric_data(**kw)
            for r in res.get("MetricDataResults", []):
                collected[r["Id"]] = collected.get(r["Id"], 0.0) + sum(r.get("Values") or [])
            token = res.get("NextToken")
            if not token:
                break
        for j, n in enumerate(batch):
            out[n] = collected.get(f"m{j}", 0.0)
    return out


def _collect(ingest_rate: float, storage_rate: float, scan_rate: float) -> dict[str, Any]:
    s = _session()
    logs = s.client("logs", region_name=config.AWS_REGION)
    cw = s.client("cloudwatch", region_name=config.AWS_REGION)
    groups = _describe(logs)
    bytes_in = _ingest(cw, [g["name"] for g in groups], LOOKBACK_DAYS)

    for g in groups:
        g["ingest_gb"] = round(bytes_in.get(g["name"], 0.0) / GB, 3)
        g["ingest_usd"] = round(g["ingest_gb"] * ingest_rate, 2)
        g["storage_usd"] = round(g["stored_gb"] * storage_rate, 2)
        g["total_usd"] = round(g["ingest_usd"] + g["storage_usd"], 2)
        flags: list[str] = []
        if g["retention_days"] is None:
            flags.append("retention_yok")
        elif g["retention_days"] > 90:
            flags.append("uzun_retention")
        if g["ingest_gb"] == 0 and g["stored_gb"] > 0.5:
            flags.append("olu")           # yazılmıyor ama yer tutuyor
        g["flags"] = flags
    groups.sort(key=lambda g: -g["total_usd"])

    no_ret = [g for g in groups if g["retention_days"] is None]
    dead = [g for g in groups if "olu" in g["flags"]]
    top = groups[:10]
    return {
        "available": True,
        "fetched_at": int(time.time() * 1000),
        "window_days": LOOKBACK_DAYS,
        "rates": {"ingest_usd_per_gb": round(ingest_rate, 4), "storage_usd_per_gb_month": round(storage_rate, 4),
                  "scan_usd_per_gb": round(scan_rate, 5)},
        "summary": {
            "groups": len(groups),
            "ingest_gb": round(sum(g["ingest_gb"] for g in groups), 1),
            "ingest_usd": round(sum(g["ingest_usd"] for g in groups), 2),
            "stored_gb": round(sum(g["stored_gb"] for g in groups), 1),
            "storage_usd": round(sum(g["storage_usd"] for g in groups), 2),
            "no_retention": len(no_ret),
            "no_retention_gb": round(sum(g["stored_gb"] for g in no_ret), 1),
            "dead": len(dead),
            "dead_gb": round(sum(g["stored_gb"] for g in dead), 1),
            "top10_share": round(sum(g["ingest_gb"] for g in top) / max(sum(g["ingest_gb"] for g in groups), 0.001), 3),
        },
        "groups": groups[:200],
        "no_retention": [g["name"] for g in no_ret[:60]],
        "dead": [{"name": g["name"], "stored_gb": g["stored_gb"]} for g in dead[:40]],
    }


async def overview(bill: dict | None = None) -> dict[str, Any]:
    """Birim fiyatlar gerçek faturadan türetilir; fatura yoksa liste fiyatı kullanılır."""
    ing = (bill or {}).get("ingest") or {}
    rate = (ing.get("cost") / ing["quantity"]) if ing.get("quantity") else config.LOGS_INGEST_USD_PER_GB
    storage = config.LOGS_STORAGE_USD_PER_GB
    if bill and bill.get("available"):
        for i in (bill.get("last_full") or {}).get("items", []):
            if "TimedStorage-ByteHrs" in i["usage_type"] and i["quantity"]:
                storage = i["cost"] / i["quantity"]
                break
    sc = (bill or {}).get("scanned") or {}
    scan_rate = (sc.get("cost") / sc["quantity"]) if sc.get("quantity") else config.CW_LOGS_USD_PER_GB
    try:
        return await asyncio.to_thread(_collect, rate, storage, scan_rate)
    except Exception as exc:  # noqa: BLE001 — yetki yoksa sayfa açıklama gösterir
        return {"available": False, "reason": f"Log grupları okunamadı: {type(exc).__name__}: {str(exc)[:200]}"}


# ------------------------------------------------------- bir log grubunun içinde ne var
SAMPLE_MIN = 15        # varsayılan örnek pencere
MAX_MINUTES = 30 * 24 * 60   # en fazla 30 gün (log saklama ve fatura dönemiyle uyumlu)
POLL_S = 1.5


def _strip_hash(stream: str) -> str:
    """'kube-apiserver-audit-abc123def' → 'kube-apiserver-audit'. EKS akış adlarındaki rastgele soneki atar."""
    parts = stream.split("-")
    while parts and (len(parts[-1]) >= 8 and all(c in "0123456789abcdef" for c in parts[-1].lower())):
        parts.pop()
    return "-".join(parts) or stream


def _query(group: str, minutes: int, ingest_rate: float, scan_rate: float) -> dict[str, Any]:
    s = _session()
    logs = s.client("logs", region_name=config.AWS_REGION)
    end = int(time.time())
    start = end - minutes * 60
    qid = logs.start_query(
        logGroupName=group, startTime=start, endTime=end,
        queryString="fields @logStream, @message | stats count(*) as adet, sum(strlen(@message)) as bayt by @logStream | sort bayt desc | limit 200",
    )["queryId"]
    # Büyük pencerede sorgu uzun sürer: bekleme bütçesi pencereyle birlikte büyür
    rounds = min(20 + minutes // 30, 120)
    res: dict[str, Any] = {}
    for _ in range(rounds):
        time.sleep(POLL_S)
        res = logs.get_query_results(queryId=qid)
        if res.get("status") in ("Complete", "Failed", "Cancelled", "Timeout"):
            break
    if res.get("status") != "Complete":
        try:
            logs.stop_query(queryId=qid)
        except Exception:  # noqa: BLE001 — zaten bitmiş olabilir
            pass
        st = res.get("statistics") or {}
        return {"available": False,
                "reason": f"Sorgu {int(rounds * POLL_S)} saniyede tamamlanamadı (durum: {res.get('status')}). "
                          "Daha kısa bir pencere seçin.",
                "scan_gb": round(float(st.get("bytesScanned") or 0) / GB, 4)}

    rows = []
    for r in res.get("results", []):
        d = {f["field"]: f["value"] for f in r}
        rows.append({"stream": d.get("@logStream", "?"),
                     "count": int(float(d.get("adet") or 0)),
                     "bytes": float(d.get("bayt") or 0)})
    total = sum(r["bytes"] for r in rows) or 1.0
    # Bileşene göre topla: EKS'te akış adının öneki bileşeni verir (apiserver, audit, scheduler…)
    comp: dict[str, dict[str, float]] = {}
    for r in rows:
        k = _strip_hash(r["stream"])
        c = comp.setdefault(k, {"bytes": 0.0, "count": 0.0, "streams": 0})
        c["bytes"] += r["bytes"]
        c["count"] += r["count"]
        c["streams"] += 1
    per_month = (30 * 24 * 60) / minutes      # pencereden aylığa ölçekle (tam 30 gün taranırsa 1)
    parts = sorted((
        {"name": k, "share": round(v["bytes"] / total, 4),
         "sample_mb": round(v["bytes"] / 1_000_000, 2),
         "lines": int(v["count"]), "streams": int(v["streams"]),
         "month_gb": round(v["bytes"] * per_month / GB, 2),
         "month_usd": round(v["bytes"] * per_month / GB * ingest_rate, 2)}
        for k, v in comp.items()), key=lambda x: -x["sample_mb"])

    st = res.get("statistics") or {}
    scanned = float(st.get("bytesScanned") or 0)
    return {
        "available": True, "group": group, "minutes": minutes,
        "full": minutes >= MAX_MINUTES,
        "scale_factor": round(per_month, 4),
        "fetched_at": int(time.time() * 1000),
        "sample_mb": round(total / 1_000_000, 2),
        "projected_month_gb": round(total * per_month / GB, 2),
        "parts": parts[:40],
        "streams": len(rows),
        # Ölçümün kendi maliyeti: saklanmaz, kullanıcıya gösterilir
        "scan_gb": round(scanned / GB, 4),
        "scan_usd": round(scanned / GB * scan_rate, 4),
    }


async def breakdown(group: str, minutes: int, bill: dict | None = None) -> dict[str, Any]:
    ing = (bill or {}).get("ingest") or {}
    rate = (ing.get("cost") / ing["quantity"]) if ing.get("quantity") else config.LOGS_INGEST_USD_PER_GB
    sc = (bill or {}).get("scanned") or {}
    scan_rate = (sc.get("cost") / sc["quantity"]) if sc.get("quantity") else config.CW_LOGS_USD_PER_GB
    try:
        return await asyncio.to_thread(_query, group, minutes, rate, scan_rate)
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": f"{type(exc).__name__}: {str(exc)[:200]}"}
