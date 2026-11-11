"""Grafana istemcisi. Bilerek yalnızca GET istekleri yapar: portal Grafana'da hiçbir şeyi değiştiremez."""
import asyncio
import base64
from typing import Any

import httpx

from . import config

_client: httpx.AsyncClient | None = None
_sem = asyncio.Semaphore(6)


def _headers() -> dict[str, str]:
    if config.GRAFANA_TOKEN:
        return {"Authorization": f"Bearer {config.GRAFANA_TOKEN}"}
    raw = f"{config.GRAFANA_USER}:{config.GRAFANA_PASS}".encode()
    return {"Authorization": "Basic " + base64.b64encode(raw).decode()}


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=config.GRAFANA_URL, headers=_headers(), timeout=90)
    return _client


class GrafanaError(RuntimeError):
    pass


async def get(path: str, org: int, params: dict[str, Any] | None = None) -> Any:
    async with _sem:
        r = await client().get(path, params=params, headers={"X-Grafana-Org-Id": str(org)})
    if r.status_code >= 400:
        raise GrafanaError(f"Grafana {path} → HTTP {r.status_code}: {r.text[:200]}")
    return r.json()


async def prom(query: str, kind: str = "query", **params: Any) -> list[dict]:
    if not config.PROM_DS_UID:
        raise GrafanaError("PROM_DS_UID tanımlı değil; SLO için Prometheus datasource UID'i gerekli.")
    path = f"/api/datasources/proxy/uid/{config.PROM_DS_UID}/api/v1/{kind}"
    data = await get(path, config.PROM_ORG, {"query": query, **params})
    if data.get("status") != "success":
        raise GrafanaError(f"Prometheus sorgusu başarısız: {data}")
    return data["data"]["result"]


def rule_url(org: int, uid: str) -> str:
    return f"{config.GRAFANA_URL}/alerting/grafana/{uid}/view?orgId={org}"


def panel_url(org: int, dash: str | None, panel: str | None) -> str | None:
    if not dash:
        return None
    url = f"{config.GRAFANA_URL}/d/{dash}?orgId={org}"
    return url + (f"&viewPanel={panel}" if panel else "")
