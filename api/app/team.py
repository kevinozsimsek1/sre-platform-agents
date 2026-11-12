"""Ekip işleri: olayı birine atama ve kişi bazında atanan işler.

Atama kaydı olayın adını ve başlangıcını da tutar; olay 30 günlük pencereden çıksa bile listede görünür.
Kim atadı / kim tamamladı bilgisi denetim kaydına düşer.
"""
from __future__ import annotations

import time

from . import config, store

ASSIGN = "assignments"
KEEP_DAYS = 90          # bundan eski atamalar silinir


def members() -> list[str]:
    return config.SRE_TEAM


async def assignments() -> dict[str, dict]:
    return await store.get(ASSIGN)


async def assign(iid: str, name: str | None, inc: dict) -> dict | None:
    if name is not None and name not in config.SRE_TEAM:
        raise ValueError("Bu isim ekip listesinde yok")
    now = int(time.time() * 1000)

    def fn(d: dict) -> None:
        if name is None:
            d.pop(iid, None)
        else:
            rules = inc.get("rules") or []
            d[iid] = {"to": name, "at": now, "done_at": None,
                      "title": rules[0]["title"] if rules else iid, "more": max(0, len(rules) - 1),
                      "severity": inc.get("severity"), "start": inc.get("start")}
        cut = now - KEEP_DAYS * 86_400_000
        for k in [k for k, v in d.items() if v.get("at", 0) < cut]:
            d.pop(k)

    d = await store.update(ASSIGN, fn)
    return d.get(iid)


async def set_done(iid: str, done: bool) -> dict:
    now = int(time.time() * 1000)

    def fn(d: dict) -> None:
        if iid not in d:
            raise KeyError(iid)
        d[iid]["done_at"] = now if done else None

    return (await store.update(ASSIGN, fn))[iid]


def work(asg: dict[str, dict], incidents: list[dict]) -> dict:
    """Kişi bazında açık / tamamlanan işler ve kimseye atanmamış açık olaylar."""
    by_id = {i["id"]: i for i in incidents}

    def row(iid: str, a: dict) -> dict:
        i = by_id.get(iid)
        return {"id": iid, **a, "known": i is not None,
                "ongoing": bool(i and i["ongoing"]), "minutes": i["minutes"] if i else None, "end": i["end"] if i else None}

    people = []
    for name in config.SRE_TEAM:
        mine = [row(k, v) for k, v in asg.items() if v.get("to") == name]
        open_ = sorted((x for x in mine if not x.get("done_at")), key=lambda x: (not x["ongoing"], -(x.get("start") or 0)))
        done = sorted((x for x in mine if x.get("done_at")), key=lambda x: -x["done_at"])
        people.append({"name": name, "open": open_, "done": done[:20], "done_total": len(done)})
    unassigned = [{"id": i["id"], "title": i["rules"][0]["title"] if i["rules"] else i["id"], "more": max(0, len(i["rules"]) - 1),
                   "severity": i["severity"], "start": i["start"], "ongoing": i["ongoing"], "minutes": i["minutes"]}
                  for i in incidents if i["ongoing"] and i["id"] not in asg]
    return {"people": people, "unassigned": unassigned}
