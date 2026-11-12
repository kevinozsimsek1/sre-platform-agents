"""Servis hedeflerinin (SLO) saklandığı yer.

Temel değerler image'daki slo-targets.toml dosyasından gelir. Yönetim ekranından yapılan değişiklikler
bunların üzerine yazılır ve kalıcı olarak saklanır:
  - Cluster'da: küçük bir ConfigMap (pod'un sadece bu ConfigMap'i okuyup yazma yetkisi vardır)
  - Lokalde: DATA_DIR/slo-targets.json dosyası
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import tomllib
from typing import Any

import httpx

from . import config

TOML_FILE = os.getenv("SLO_TARGETS_FILE", os.path.join(os.path.dirname(__file__), "..", "slo-targets.toml"))
CONFIGMAP = os.getenv("SLO_TARGETS_CONFIGMAP", "")  # ör. sre-portal-slo-targets; boşsa dosya kullanılır
SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
KEY = "targets.json"
LOCAL_FILE = os.path.join(config.DATA_DIR, "slo-targets.json")

_lock = asyncio.Lock()
_cache: tuple[float, dict] | None = None
CACHE_S = 30


def _toml() -> dict:
    try:
        with open(TOML_FILE, "rb") as f:
            return tomllib.load(f)
    except FileNotFoundError:
        return {}


# ------------------------------------------------------------- kalıcı katman
def _k8s() -> tuple[str, dict, str] | None:
    if not CONFIGMAP or not os.path.exists(f"{SA_DIR}/token"):
        return None
    ns = open(f"{SA_DIR}/namespace").read().strip()
    token = open(f"{SA_DIR}/token").read().strip()
    url = f"https://kubernetes.default.svc/api/v1/namespaces/{ns}/configmaps/{CONFIGMAP}"
    return url, {"Authorization": f"Bearer {token}"}, f"{SA_DIR}/ca.crt"


async def _read_overrides() -> dict:
    k = _k8s()
    if k:
        url, headers, ca = k
        async with httpx.AsyncClient(verify=ca, timeout=10) as c:
            r = await c.get(url, headers=headers)
        if r.status_code == 404:
            return {}
        r.raise_for_status()
        return json.loads((r.json().get("data") or {}).get(KEY) or "{}")
    try:
        with open(LOCAL_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


async def _write_overrides(data: dict) -> None:
    body = json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True)
    k = _k8s()
    if k:
        url, headers, ca = k
        async with httpx.AsyncClient(verify=ca, timeout=10) as c:
            r = await c.patch(url, headers={**headers, "Content-Type": "application/merge-patch+json"}, json={"data": {KEY: body}})
        r.raise_for_status()
        return
    os.makedirs(config.DATA_DIR, exist_ok=True)
    tmp = LOCAL_FILE + ".tmp"
    with open(tmp, "w") as f:
        f.write(body)
    os.replace(tmp, LOCAL_FILE)


# ------------------------------------------------------------- okuma / yazma
async def load(force: bool = False) -> dict[str, Any]:
    """{"default": {...}, "services": {svc: {...}}} — toml + yönetim ekranındaki değişiklikler."""
    global _cache
    if _cache and not force and time.time() - _cache[0] < CACHE_S:
        return _cache[1]
    base = _toml()
    over = await _read_overrides()
    default = {"availability": 99.9, "latency_ms": 500, "latency_target": 99.0, **base.get("default", {}), **over.get("default", {})}
    services = {**base.get("services", {})}
    for svc, v in (over.get("services") or {}).items():
        if v is None:
            services.pop(svc, None)
        else:
            services[svc] = v
    _cache = (time.time(), {"default": default, "services": services})
    return _cache[1]


def cached() -> dict[str, Any]:
    """Senkron erişim (hesaplama sırasında): son yüklenen hedefler."""
    if _cache:
        return _cache[1]
    base = _toml()
    return {"default": {"availability": 99.9, "latency_ms": 500, "latency_target": 99.0, **base.get("default", {})},
            "services": base.get("services", {})}


def _clean(v: dict) -> dict:
    out: dict[str, Any] = {}
    for k in ("availability", "latency_target"):
        if v.get(k) is not None:
            x = float(v[k])
            if not 50 <= x <= 100:
                raise ValueError(f"{k} 50 ile 100 arasında olmalı")
            out[k] = round(x, 3)
    if v.get("latency_ms") is not None:
        x = int(v["latency_ms"])
        if not 1 <= x <= 60000:
            raise ValueError("latency_ms 1 ile 60000 arasında olmalı")
        out["latency_ms"] = x
    for k in ("owner", "note"):
        if v.get(k):
            out[k] = str(v[k]).strip()[:200]
    return out


async def save(service: str | None, values: dict | None) -> None:
    """service=None → varsayılan hedef. values=None → servisin özel hedefini kaldır (varsayılana dön)."""
    async with _lock:
        over = await _read_overrides()
        if service is None:
            over["default"] = _clean(values or {})
        else:
            over.setdefault("services", {})[service] = _clean(values) if values is not None else None
        await _write_overrides(over)
        await load(force=True)
