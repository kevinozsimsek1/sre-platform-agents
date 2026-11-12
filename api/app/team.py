"""Ekip işleri: olayı birine atama ve alert başına runbook.

Kim atadı / kim değiştirdi bilgisi denetim kaydına düşer; burada sadece son durum tutulur.
"""
from __future__ import annotations

import time

from . import config, store

ASSIGN = "assignments"
RUNBOOK = "runbooks"
KEEP_DAYS = 45          # bundan eski atamalar silinir (olaylar zaten 30 günlük)
RUNBOOK_MAX = 4000      # karakter


def members() -> list[str]:
    return config.SRE_TEAM


# ------------------------------------------------------------- atama
async def assignments() -> dict[str, dict]:
    return await store.get(ASSIGN)


async def assign(iid: str, name: str | None) -> dict | None:
    if name is not None and name not in config.SRE_TEAM:
        raise ValueError("Bu isim ekip listesinde yok")
    now = int(time.time() * 1000)

    def fn(d: dict) -> None:
        if name is None:
            d.pop(iid, None)
        else:
            d[iid] = {"to": name, "at": now}
        cut = now - KEEP_DAYS * 86_400_000
        for k in [k for k, v in d.items() if v.get("at", 0) < cut]:
            d.pop(k)

    d = await store.update(ASSIGN, fn)
    return d.get(iid)


# ------------------------------------------------------------- runbook
async def runbooks() -> dict[str, dict]:
    return await store.get(RUNBOOK)


async def set_runbook(rule_key: str, text: str) -> dict | None:
    text = (text or "").strip()
    if len(text) > RUNBOOK_MAX:
        raise ValueError(f"Runbook en fazla {RUNBOOK_MAX} karakter olabilir")
    now = int(time.time() * 1000)

    def fn(d: dict) -> None:
        if text:
            d[rule_key] = {"text": text, "at": now}
        else:
            d.pop(rule_key, None)

    d = await store.update(RUNBOOK, fn)
    return d.get(rule_key)
