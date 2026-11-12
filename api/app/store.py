"""Küçük, kalıcı JSON belgeleri: olay atamaları.

  - Cluster'da: STATE_CONFIGMAP adlı ConfigMap'in içinde her belge ayrı bir anahtar (pod sadece bu ConfigMap'i okuyup yazabilir)
  - Lokalde: DATA_DIR/<ad>.json

Ücretsizdir; ConfigMap sınırı ~1 MB olduğu için belgeler küçük tutulur (eski kayıtlar temizlenir).
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

import httpx

from . import config

CONFIGMAP = os.getenv("STATE_CONFIGMAP", "")  # ör. sre-portal-state; boşsa dosya kullanılır
SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
CACHE_S = 15

_lock = asyncio.Lock()
_cache: dict[str, tuple[float, dict]] = {}


def _k8s() -> tuple[str, dict, str] | None:
    if not CONFIGMAP or not os.path.exists(f"{SA_DIR}/token"):
        return None
    ns = open(f"{SA_DIR}/namespace").read().strip()
    token = open(f"{SA_DIR}/token").read().strip()
    url = f"https://kubernetes.default.svc/api/v1/namespaces/{ns}/configmaps/{CONFIGMAP}"
    return url, {"Authorization": f"Bearer {token}"}, f"{SA_DIR}/ca.crt"


def _file(name: str) -> str:
    return os.path.join(config.DATA_DIR, f"{name}.json")


async def _read(name: str) -> dict:
    k = _k8s()
    if k:
        url, headers, ca = k
        async with httpx.AsyncClient(verify=ca, timeout=10) as c:
            r = await c.get(url, headers=headers)
        if r.status_code == 404:
            return {}
        r.raise_for_status()
        return json.loads((r.json().get("data") or {}).get(f"{name}.json") or "{}")
    try:
        with open(_file(name)) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


async def _write(name: str, data: dict) -> None:
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    k = _k8s()
    if k:
        url, headers, ca = k
        async with httpx.AsyncClient(verify=ca, timeout=10) as c:
            r = await c.patch(url, headers={**headers, "Content-Type": "application/merge-patch+json"},
                              json={"data": {f"{name}.json": body}})
        r.raise_for_status()
        return
    os.makedirs(config.DATA_DIR, exist_ok=True)
    tmp = _file(name) + ".tmp"
    with open(tmp, "w") as f:
        f.write(body)
    os.replace(tmp, _file(name))


async def get(name: str) -> dict:
    hit = _cache.get(name)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    data = await _read(name)
    _cache[name] = (time.time(), data)
    return data


async def update(name: str, fn) -> dict:
    """fn(data) belgeyi yerinde değiştirir. Okuma-değiştirme-yazma kilit altında yapılır."""
    async with _lock:
        data = await _read(name)
        fn(data)
        await _write(name, data)
        _cache[name] = (time.time(), data)
        return data


def peek(name: str) -> dict:
    """Senkron erişim: son okunan hali (yoksa boş)."""
    hit = _cache.get(name)
    return hit[1] if hit else {}
