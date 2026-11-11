"""SLO ve hata bütçesi. Kaynak: OpenTelemetry http_server_request_duration_seconds (Prometheus).

SLI tanımları (Google SRE workbook'a uygun, istek tabanlı):
  - Erişilebilirlik: 5xx olmayan istek / tüm istek
  - Gecikme: SLO_LATENCY_LE saniyenin altında biten istek / tüm istek
Sağlık kontrolü uçları (health, ready, live, metrics ...) ve WebSocket upgrade (101) hariç tutulur.
"""
from __future__ import annotations

import asyncio
import time

from . import config, grafana

M = "http_server_request_duration_seconds"
FIVEXX = 'http_response_status_code=~"5.."'


def le_sel() -> str:
    return f'le="{config.SLO_LATENCY_LE}"'


def _sel(extra: str = "") -> str:
    base = f'http_route!~"{config.SLO_EXCLUDE_ROUTES}",http_route!="",http_response_status_code!="101"'
    return "{" + base + (("," + extra) if extra else "") + "}"


def _num(res: list[dict], key: str = "service_name") -> dict[str, float]:
    return {r["metric"].get(key, "?"): float(r["value"][1]) for r in res}


async def _window(rng: str, svc: str | None = None, by: str = "service_name") -> dict[str, dict[str, float]]:
    base = [f'service_name="{svc}"'] if svc else []

    def sel(*extra: str) -> str:
        return _sel(",".join(base + list(extra)))

    total, bad, fast = await asyncio.gather(
        grafana.prom(f"sum by ({by}) (increase({M}_count{sel()}[{rng}]))"),
        grafana.prom(f'sum by ({by}) (increase({M}_count{sel(FIVEXX)}[{rng}]))'),
        grafana.prom(f"sum by ({by}) (increase({M}_bucket{sel(le_sel())}[{rng}]))"),
    )
    t, b, fa = _num(total, by), _num(bad, by), _num(fast, by)
    return {k: {"total": v, "bad": b.get(k, 0.0), "fast": fa.get(k, 0.0)} for k, v in t.items()}


def _sli(w: dict[str, float]) -> dict[str, float | None]:
    t = w["total"]
    if t <= 0:
        return {"availability": None, "latency": None}
    return {"availability": 1 - w["bad"] / t, "latency": min(1.0, w["fast"] / t)}


def _budget(w: dict[str, float]) -> dict[str, float | None]:
    """Kalan hata bütçesi (0–1, negatifse aşılmış) ve tüketim hızı (burn rate)."""
    t = w["total"]
    if t <= 0:
        return {"avail_left": None, "lat_left": None}
    allowed_bad = (1 - config.SLO_AVAILABILITY) * t
    allowed_slow = (1 - config.SLO_LATENCY) * t
    slow = max(0.0, t - w["fast"])
    return {"avail_left": 1 - w["bad"] / allowed_bad if allowed_bad else None,
            "lat_left": 1 - slow / allowed_slow if allowed_slow else None}


def _burn(w: dict[str, float] | None, target: float, kind: str) -> float | None:
    if not w or w["total"] <= 0:
        return None
    err = w["bad"] / w["total"] if kind == "a" else max(0.0, w["total"] - w["fast"]) / w["total"]
    return round(err / (1 - target), 2)


async def overview() -> dict:
    rng = f"{config.WINDOW_DAYS}d"
    w30, w7, w1 = await asyncio.gather(_window(rng), _window("7d"), _window("1d"))
    services = []
    for svc, w in w30.items():
        sli, bud = _sli(w), _budget(w)
        enough = w["total"] >= config.SLO_MIN_REQUESTS
        status = "low_traffic"
        if enough:
            worst = min(x for x in (bud["avail_left"], bud["lat_left"]) if x is not None)
            status = "breached" if worst < 0 else "at_risk" if worst < 0.25 else "ok"
        services.append({
            "service": svc, "requests": int(w["total"]), "errors_5xx": int(w["bad"]), "slow": int(max(0, w["total"] - w["fast"])),
            **sli, **bud, "status": status,
            "burn_7d": {"availability": _burn(w7.get(svc), config.SLO_AVAILABILITY, "a"), "latency": _burn(w7.get(svc), config.SLO_LATENCY, "l")},
            "burn_1d": {"availability": _burn(w1.get(svc), config.SLO_AVAILABILITY, "a"), "latency": _burn(w1.get(svc), config.SLO_LATENCY, "l")},
        })
    order = {"breached": 0, "at_risk": 1, "ok": 2, "low_traffic": 3}
    services.sort(key=lambda s: (order[s["status"]], -s["requests"]))
    return {
        "fetched_at": int(time.time() * 1000),
        "objectives": {"availability": config.SLO_AVAILABILITY, "latency": config.SLO_LATENCY, "latency_le_s": float(config.SLO_LATENCY_LE),
                       "window_days": config.WINDOW_DAYS, "min_requests": config.SLO_MIN_REQUESTS},
        "services": services,
    }


async def service_detail(svc: str) -> dict:
    rng = f"{config.WINDOW_DAYS}d"
    now = int(time.time())
    step = 86400
    f = f'service_name="{svc}"'

    async def daily(q: str) -> dict[int, float]:
        res = await grafana.prom(q, "query_range", start=now - config.WINDOW_DAYS * step, end=now, step=step)
        return {int(t): float(v) for r in res for t, v in r["values"]}

    total_d, bad_d, fast_d, routes, codes, p95 = await asyncio.gather(
        daily(f"sum(increase({M}_count{_sel(f)}[1d]))"),
        daily(f"sum(increase({M}_count{_sel(f + ',' + FIVEXX)}[1d]))"),
        daily(f"sum(increase({M}_bucket{_sel(f + ',' + le_sel())}[1d]))"),
        _window(rng, svc, by="http_route"),
        grafana.prom(f"sum by (http_response_status_code) (increase({M}_count{_sel(f)}[{rng}]))"),
        grafana.prom(f"histogram_quantile(0.95, sum by (le, http_route) (rate({M}_bucket{_sel(f)}[7d])))"),
    )
    days = []
    for t in sorted(total_d):
        tot = total_d[t]
        days.append({"t": t * 1000, "requests": int(tot),
                     "availability": (1 - bad_d.get(t, 0) / tot) if tot > 0 else None,
                     "latency": min(1.0, fast_d.get(t, 0) / tot) if tot > 0 else None})
    p95m = {r["metric"].get("http_route"): float(r["value"][1]) for r in p95 if r["value"][1] not in ("NaN", "+Inf")}
    route_rows = [{"route": k, "requests": int(v["total"]), "errors_5xx": int(v["bad"]), "slow": int(max(0, v["total"] - v["fast"])),
                   "p95_s": p95m.get(k)} for k, v in routes.items() if v["total"] >= 1]
    route_rows.sort(key=lambda r: (-r["errors_5xx"], -r["slow"], -r["requests"]))
    ov = await overview()
    me = next((s for s in ov["services"] if s["service"] == svc), None)
    return {"fetched_at": int(time.time() * 1000), "objectives": ov["objectives"], "service": me, "daily": days,
            "routes": route_rows[:40], "codes": sorted(({"code": r["metric"].get("http_response_status_code"), "count": int(float(r["value"][1]))} for r in codes), key=lambda c: c["code"] or "")}
