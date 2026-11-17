"""Prod hesabının gerçek CloudWatch faturası (AWS Cost Explorer).

Tahmin değil, kesilmiş fatura okunur. Sorgu maliyeti sayfasının üst kısmı buradan beslenir;
yapısal analiz (hangi kural kaç kez tarıyor) ise faturayı açıklamak için altında durur.

Dikkat: Cost Explorer her istek için ücret alır ($0.01). Bu yüzden uzun önbellekle kullanılır.
Yalnızca okuma yapılır (ce:GetCostAndUsage).
"""
from __future__ import annotations

import asyncio
import time
from datetime import date, timedelta
from typing import Any

from . import config

SERVICE = "AmazonCloudWatch"
# Fatura kalemlerinin ne anlama geldiği: sunumda "bu satır ne" sorusuna cevap.
MEANING: dict[str, dict[str, str]] = {
    "CW:GMD-Metrics": {"label": "Metrik sorgusu (GetMetricData)",
                       "what": "Dashboard ve alert kurallarının CloudWatch'tan metrik çekmesi. İstenen metrik sayısıyla ücretlenir."},
    "DataScanned-Bytes": {"label": "Logs Insights taraması",
                          "what": "Log sorgularının taradığı bayt. Sorgu penceresi uzadıkça ve sık çalıştıkça artar."},
    "DataProcessing-Bytes": {"label": "Log alımı",
                             "what": "CloudWatch Logs'a yazılan log hacmi. Uygulamaların ürettiği log miktarına bağlı."},
    "VendedLog-Bytes": {"label": "Servis logları (ALB, WAF, VPC)",
                        "what": "AWS servislerinin kendi loglarını teslim etmesi. İlgili servisin log ayarından kapatılır."},
    "CW:MetricMonitorUsage": {"label": "Özel metrik",
                              "what": "Uygulamaların CloudWatch'a yazdığı kendi metrikleri (metrik başına aylık ücret)."},
    "CW:AlarmMonitorUsage": {"label": "CloudWatch alarmı",
                             "what": "CloudWatch'un kendi alarmları. Grafana alert'lerinden ayrıdır."},
    "CW:MetricStreamUsage": {"label": "Metric Stream",
                             "what": "Metriklerin sürekli dışa akıtılması. Kullanılmıyorsa kapatılmalı."},
    "DashboardsUsageHour": {"label": "CloudWatch dashboard'u",
                            "what": "CloudWatch konsolundaki dashboard'lar (ilk 3 ücretsiz). Grafana ile ilgisi yok."},
    "CW:Requests": {"label": "API isteği", "what": "CloudWatch API çağrıları; büyük kısmı ücretsiz kotada kalır."},
    "TimedStorage-ByteHrs": {"label": "Log saklama", "what": "Logların diskte durduğu süre. Saklama süresi kısaltılınca düşer."},
    "S3-Egress-Bytes": {"label": "S3'e log aktarımı", "what": "Logların S3'e dışa aktarılması."},
    "CW:ContributorRulesManaged": {"label": "Contributor Insights", "what": "Kural başına aylık ücret."},
    "CW:MetricInsightAlarmUsage": {"label": "Metrics Insights alarmı", "what": "Sorgu tabanlı alarmlar."},
    "CW:ObservationUsage": {"label": "Application Signals", "what": "Gözlem başına ücret."},
}


def _meaning(usage_type: str) -> dict[str, str]:
    """'EUC1-CW:GMD-Metrics' → anlam. Bölge öneki atılır."""
    bare = usage_type.split("-", 1)[-1] if "-" in usage_type and usage_type.split("-", 1)[0].isalnum() else usage_type
    for key, m in MEANING.items():
        if bare == key or bare.startswith(key) or usage_type.endswith(key):
            return m
    return {"label": bare, "what": ""}


def _client():
    import boto3  # yalnızca bu modül kullanır

    session = boto3.Session(profile_name=config.COST_AWS_PROFILE) if config.COST_AWS_PROFILE else boto3.Session()
    return session.client("ce", region_name="us-east-1")  # Cost Explorer yalnızca us-east-1


def _collect(months: int = 4) -> dict[str, Any]:
    ce = _client()
    today = date.today()
    start = (today.replace(day=1) - timedelta(days=31 * (months - 1))).replace(day=1)
    res = ce.get_cost_and_usage(
        TimePeriod={"Start": start.isoformat(), "End": (today + timedelta(days=1)).isoformat()},
        Granularity="MONTHLY",
        Metrics=["UnblendedCost", "UsageQuantity"],
        Filter={"Dimensions": {"Key": "SERVICE", "Values": [SERVICE]}},
        GroupBy=[{"Type": "DIMENSION", "Key": "USAGE_TYPE"}],
    )
    months_out: list[dict[str, Any]] = []
    for p in res["ResultsByTime"]:
        items = []
        for g in p["Groups"]:
            cost = float(g["Metrics"]["UnblendedCost"]["Amount"])
            qty = float(g["Metrics"]["UsageQuantity"]["Amount"])
            if cost < 0.005 and qty <= 0:
                continue
            ut = g["Keys"][0]
            m = _meaning(ut)
            items.append({"usage_type": ut, "label": m["label"], "what": m["what"],
                          "cost": round(cost, 2), "quantity": qty})
        items.sort(key=lambda x: -x["cost"])
        months_out.append({
            "start": p["TimePeriod"]["Start"], "end": p["TimePeriod"]["End"],
            "partial": p["TimePeriod"]["End"] > today.isoformat(),
            "total": round(sum(i["cost"] for i in items), 2),
            "items": items,
        })
    latest = months_out[-1] if months_out else {"items": [], "total": 0.0}
    full = [m for m in months_out if not m["partial"]]
    last_full = full[-1] if full else latest

    def line(key: str, src: dict) -> dict[str, Any]:
        hit = [i for i in src["items"] if key in i["usage_type"]]
        return {"cost": round(sum(i["cost"] for i in hit), 2), "quantity": sum(i["quantity"] for i in hit)}

    return {
        "available": True,
        "fetched_at": int(time.time() * 1000),
        "account": config.AWS_PROD_ACCOUNT or None,
        "service": SERVICE,
        "months": months_out,
        "last_full": last_full,
        "current": latest,
        # Sayfanın yapısal analiziyle eşleşen kalemler
        "gmd": line("CW:GMD-Metrics", last_full),
        "scanned": line("DataScanned-Bytes", last_full),
        "ingest": line("DataProcessing-Bytes", last_full),
    }


async def overview() -> dict[str, Any]:
    try:
        return await asyncio.to_thread(_collect)
    except Exception as exc:  # yetki yoksa sayfanın kalanı yine çalışsın
        return {"available": False,
                "reason": f"Cost Explorer okunamadı: {type(exc).__name__}: {str(exc)[:200]}"}
