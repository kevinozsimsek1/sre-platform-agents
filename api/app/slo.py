"""Servis hedefleri (SLO). Kaynak: OpenTelemetry http_server_request_duration_seconds (Prometheus).

Ölçüler (istek tabanlı):
  - Erişilebilirlik: 5xx dönmeyen istek / tüm istek
  - Hız: belirlenen süre sınırının altında biten istek / tüm istek
Sağlık kontrolü uçları ve WebSocket upgrade (101) sayılmaz.

Hedefler yönetim ekranından belirlenir (temel değerler slo-targets.toml, değişiklikler targets.py'de saklanır).
Hedefi olmayan servislerde varsayılan kullanılır. Portal geçmiş performansa göre bir hedef de önerir
(öneri sadece yönetim ekranında görünür).
"""
from __future__ import annotations

import asyncio
import math
import time
from typing import Any

from . import config, grafana, targets

M = "http_server_request_duration_seconds"
FIVEXX = 'http_response_status_code=~"5.."'
BUCKETS_MS = [5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]
STANDARD_AVAIL = [99.99, 99.95, 99.9, 99.5, 99.0, 98.0, 95.0]


# ------------------------------------------------------------- hedefler
def _load_targets() -> tuple[dict, dict]:
    t = targets.cached()
    return t["default"], t["services"]


def _bucket(ms: float) -> int:
    """Süre sınırını histogramdaki en yakın (eşit ya da büyük) sınıra yuvarlar."""
    return next((b for b in BUCKETS_MS if b >= ms), BUCKETS_MS[-1])


def target_for(svc: str) -> dict[str, Any]:
    default, services = _load_targets()
    own = services.get(svc)
    t = {**default, **(own or {})}
    le_ms = _bucket(float(t["latency_ms"]))
    return {
        "availability": round(float(t["availability"]) / 100, 6), "latency_ms": le_ms, "latency_target": round(float(t["latency_target"]) / 100, 6),
        "source": "tanımlı" if own else "varsayılan", "owner": t.get("owner"), "note": t.get("note"),
        "approx": le_ms != float(t["latency_ms"]),
    }


# ------------------------------------------------------------- sorgular
def _sel(extra: str = "") -> str:
    base = f'http_route!~"{config.SLO_EXCLUDE_ROUTES}",http_route!="",http_response_status_code!="101"'
    return "{" + base + (("," + extra) if extra else "") + "}"


async def _window(rng: str, svc: str | None = None, by: str = "service_name") -> dict[str, dict]:
    """Her grup için: toplam, 5xx ve süre sınırı (bucket) başına hızlı istek sayısı."""
    f = f'service_name="{svc}"' if svc else ""
    sel = lambda extra="": _sel(",".join(x for x in (f, extra) if x))  # noqa: E731
    total, bad, buckets = await asyncio.gather(
        grafana.prom(f"sum by ({by}) (increase({M}_count{sel()}[{rng}]))"),
        grafana.prom(f"sum by ({by}) (increase({M}_count{sel(FIVEXX)}[{rng}]))"),
        grafana.prom(f"sum by ({by}, le) (increase({M}_bucket{sel()}[{rng}]))"),
    )
    out: dict[str, dict] = {}
    for r in total:
        out[r["metric"].get(by, "?")] = {"total": float(r["value"][1]), "bad": 0.0, "le": {}}
    for r in bad:
        k = r["metric"].get(by, "?")
        if k in out:
            out[k]["bad"] = float(r["value"][1])
    for r in buckets:
        k, le = r["metric"].get(by, "?"), r["metric"].get("le")
        if k in out and le and le != "+Inf":
            out[k]["le"][round(float(le) * 1000)] = float(r["value"][1])
    return out


def _fast(w: dict, le_ms: int) -> float:
    return min(w["le"].get(le_ms, 0.0), w["total"])


def _p(w: dict, q: float) -> float | None:
    """Histogramdan yaklaşık yüzdelik (ms): q oranındaki isteğin bittiği ilk sınır."""
    if w["total"] <= 0:
        return None
    for b in BUCKETS_MS:
        if w["le"].get(b, 0) >= q * w["total"]:
            return b
    return None


def _suggest(w: dict) -> dict[str, Any]:
    """Geçmiş performansa göre gerçekçi hedef: bugün tutturulabilen en iddialı standart seviye."""
    if w["total"] < config.SLO_MIN_REQUESTS:
        return {}
    avail = 100 * (1 - w["bad"] / w["total"])
    av = next((a for a in STANDARD_AVAIL if a <= avail), STANDARD_AVAIL[-1])
    p99 = _p(w, 0.99)
    out: dict[str, Any] = {"availability": round(av / 100, 6)}
    if p99:
        # İsteklerin %99'unun bittiği sınır; en az 100 ms ki küçük dalgalanmalar hedefi bozmasın
        out.update(latency_ms=max(100, p99), latency_target=0.99)
    return out


def _measure(w: dict | None, t: dict) -> dict[str, Any] | None:
    if not w or w["total"] <= 0:
        return None
    fast = _fast(w, t["latency_ms"])
    return {"requests": int(w["total"]), "errors_5xx": int(w["bad"]), "slow": int(max(0, w["total"] - fast)),
            "availability": 1 - w["bad"] / w["total"], "latency": fast / w["total"]}


def _status(m: dict | None, t: dict) -> str:
    if not m or m["requests"] < config.SLO_MIN_REQUESTS:
        return "low_traffic"
    if m["availability"] < t["availability"] or m["latency"] < t["latency_target"]:
        return "breached"
    # hedefin üstünde ama payın çoğunu kullanmış
    a_room = (1 - t["availability"]) * m["requests"]
    l_room = (1 - t["latency_target"]) * m["requests"]
    used = max(m["errors_5xx"] / a_room if a_room else 0, m["slow"] / l_room if l_room else 0)
    return "at_risk" if used > 0.75 else "ok"


def _trend(m30: dict | None, m7: dict | None) -> str | None:
    """Son 7 gün, 30 günlük ortalamadan belirgin şekilde iyi mi kötü mü?"""
    if not m30 or not m7 or m7["requests"] < 200:
        return None
    a = (1 - m7["latency"]) - (1 - m30["latency"])
    b = (1 - m7["availability"]) - (1 - m30["availability"])
    d = a + 10 * b
    if d > 0.005:
        return "worse"
    if d < -0.005:
        return "better"
    return "same"


def _explain(m: dict | None, t: dict) -> str | None:
    """Teknik olmayan dille tek cümle."""
    if not m or m["requests"] <= 0:
        return None
    parts = []
    if m["latency"] < t["latency_target"]:
        share = m["slow"] / m["requests"]
        if share >= 0.3:
            parts.append(f"{t['latency_ms']} ms'den yavaş istek oranı %{round(share * 100)}")
        else:
            parts.append(f"her {math.floor(m['requests'] / max(m['slow'], 1))} istekten 1'i {t['latency_ms']} ms'den yavaş")
    if m["availability"] < t["availability"]:
        n = m["requests"] / max(m["errors_5xx"], 1)
        parts.append(f"her {math.floor(n):,} istekten 1'i hata ile sonuçlanıyor".replace(",", "."))
    if not parts:
        return "Hedefin içinde."
    text = "; ".join(parts)
    first = {"i": "İ", "ı": "I"}.get(text[0], text[0].upper())
    return first + text[1:] + "."


async def overview() -> dict:
    await targets.load()
    rng = f"{config.WINDOW_DAYS}d"
    w30, w7 = await asyncio.gather(_window(rng), _window("7d"))
    default, _ = _load_targets()
    services = []
    for svc, w in w30.items():
        t = target_for(svc)
        m, m7 = _measure(w, t), _measure(w7.get(svc), t)
        allowed_slow = int((1 - t["latency_target"]) * m["requests"]) if m else 0
        allowed_err = int((1 - t["availability"]) * m["requests"]) if m else 0
        services.append({
            "service": svc, "target": t, "measured": m, "status": _status(m, t), "trend": _trend(m, m7),
            "explain": _explain(m, t), "allowed": {"slow": allowed_slow, "errors": allowed_err},
            "suggested": _suggest(w), "p99_ms": _p(w, 0.99), "p95_ms": _p(w, 0.95),
        })
    order = {"breached": 0, "at_risk": 1, "ok": 2, "low_traffic": 3}
    services.sort(key=lambda s: (order[s["status"]], -(s["measured"] or {}).get("requests", 0)))
    return {
        "fetched_at": int(time.time() * 1000), "window_days": config.WINDOW_DAYS, "min_requests": config.SLO_MIN_REQUESTS,
        "default": {"availability": round(float(default["availability"]) / 100, 6), "latency_ms": _bucket(float(default["latency_ms"])),
                    "latency_target": round(float(default["latency_target"]) / 100, 6)},
        "services": services,
    }


async def service_detail(svc: str) -> dict:
    t = target_for(svc)
    now = int(time.time())
    step = 86400
    f = f'service_name="{svc}"'

    async def daily(q: str) -> dict[int, float]:
        res = await grafana.prom(q, "query_range", start=now - config.WINDOW_DAYS * step, end=now, step=step)
        return {int(ts): float(v) for r in res for ts, v in r["values"]}

    le_sel = f'le="{t["latency_ms"] / 1000:g}"'  # Prometheus'taki biçim: 0.5, 1, 2.5 ...
    total_d, bad_d, fast_d, routes, codes, p95 = await asyncio.gather(
        daily(f"sum(increase({M}_count{_sel(f)}[1d]))"),
        daily(f"sum(increase({M}_count{_sel(f + ',' + FIVEXX)}[1d]))"),
        daily(f"sum(increase({M}_bucket{_sel(f + ',' + le_sel)}[1d]))"),
        _window(f"{config.WINDOW_DAYS}d", svc, by="http_route"),
        grafana.prom(f"sum by (http_response_status_code) (increase({M}_count{_sel(f)}[{config.WINDOW_DAYS}d]))"),
        grafana.prom(f"histogram_quantile(0.95, sum by (le, http_route) (rate({M}_bucket{_sel(f)}[7d])))"),
    )
    days = []
    for ts in sorted(total_d):
        tot = total_d[ts]
        days.append({"t": ts * 1000, "requests": int(tot),
                     "availability": (1 - bad_d.get(ts, 0) / tot) if tot > 0 else None,
                     "latency": min(1.0, fast_d.get(ts, 0) / tot) if tot > 0 else None})
    p95m = {r["metric"].get("http_route"): float(r["value"][1]) for r in p95 if r["value"][1] not in ("NaN", "+Inf")}
    rows = []
    for k, w in routes.items():
        if w["total"] < 1:
            continue
        fast = _fast(w, t["latency_ms"])
        rows.append({"route": k, "requests": int(w["total"]), "errors_5xx": int(w["bad"]), "slow": int(max(0, w["total"] - fast)),
                     "p95_s": p95m.get(k)})
    rows.sort(key=lambda r: (-r["errors_5xx"], -r["slow"], -r["requests"]))
    ov = await overview()
    me = next((s for s in ov["services"] if s["service"] == svc), None)
    return {"fetched_at": int(time.time() * 1000), "window_days": config.WINDOW_DAYS,
            "service": me, "daily": days, "routes": rows[:40],
            "codes": sorted(({"code": r["metric"].get("http_response_status_code"), "count": int(float(r["value"][1]))} for r in codes), key=lambda c: c["code"] or "")}
