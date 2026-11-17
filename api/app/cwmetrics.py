"""Bir sorgunun kaç metriğe açıldığını CloudWatch'a sorarak ölçer.

Boyutu olmayan ya da joker içeren bir sorgu, "1 sorgu" gibi görünse de AWS'den çok sayıda metrik
ister ve her metrik ayrı ücretlenir. ListMetrics ücretsizdir ve kaç metriğin eşleştiğini kesin söyler;
böylece dashboard kırılımı oranlama değil, ölçüm olur.

Erişim yoksa ya da çağrı başarısızsa sayım atlanır ve sayfa oranlamaya geri döner.
"""
from __future__ import annotations

import asyncio
import re
from typing import Any

from . import config

CAP = 500          # bir sorgu için sayılan en fazla metrik (sayfalama maliyetini sınırlar)
MAX_LOOKUPS = 120  # tek analizde yapılacak en fazla ListMetrics çağrısı
_cache: dict[tuple, int] = {}


def _client():
    import boto3

    session = boto3.Session(profile_name=config.COST_AWS_PROFILE) if config.COST_AWS_PROFILE else boto3.Session()
    return session.client("cloudwatch", region_name=config.AWS_REGION)


def _key(t: dict) -> tuple | None:
    """Sayım için anahtar: namespace, metrik ve boyut filtresi. Şablon değişkenleri joker sayılır."""
    ns, name = t.get("namespace"), t.get("metricName")
    if not ns or not name:
        return None
    dims: list[tuple[str, str | None]] = []
    for k, v in (t.get("dimensions") or {}).items():
        val = v[0] if isinstance(v, list) and len(v) == 1 else v
        if not isinstance(val, str) or val == "*" or val.startswith("$") or re.search(r"[*?]", val):
            dims.append((k, None))          # yalnızca boyut adıyla eşleştir
        elif isinstance(v, list) and len(v) > 1:
            dims.append((k, None))
        else:
            dims.append((k, val))
    return (str(ns), str(name), tuple(sorted(dims)))


def _count(cw, key: tuple) -> int:
    ns, name, dims = key
    filters = [{"Name": k, **({"Value": v} if v is not None else {})} for k, v in dims]
    kwargs: dict[str, Any] = {"Namespace": ns, "MetricName": name}
    if filters:
        kwargs["Dimensions"] = filters
    n = 0
    token = None
    while True:
        if token:
            kwargs["NextToken"] = token
        page = cw.list_metrics(**kwargs)
        n += len(page.get("Metrics", []))
        token = page.get("NextToken")
        if not token or n >= CAP:
            return min(n, CAP)


def _collect(keys: list[tuple]) -> dict[tuple, int]:
    cw = _client()
    out: dict[tuple, int] = {}
    for k in keys[:MAX_LOOKUPS]:
        try:
            out[k] = _count(cw, k)
        except Exception:  # noqa: BLE001 — tek sorgu sayılamazsa diğerleri yine sayılsın
            continue
    return out


async def resolve(targets: list[dict]) -> dict[tuple, int]:
    """Verilen hedefler için {anahtar: metrik sayısı}. Erişim yoksa boş döner."""
    keys = []
    for t in targets:
        k = _key(t)
        if k and k not in _cache and k not in keys:
            keys.append(k)
    if keys:
        try:
            _cache.update(await asyncio.to_thread(_collect, keys))
        except Exception:  # noqa: BLE001 — kimlik yoksa sayfa yine çalışsın
            return dict(_cache)
    return dict(_cache)


def count_for(t: dict, counts: dict[tuple, int]) -> int | None:
    k = _key(t)
    return counts.get(k) if k else None
