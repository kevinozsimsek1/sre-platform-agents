"""Prod'daki değişiklikler (deploy / restart) ve olaylarla ilişkisi.

Kaynak: kube-state-metrics (Prometheus). Her yeni ReplicaSet, deployment'ın pod şablonunun değiştiği
bir andır (yeni image, ayar değişikliği ya da `rollout restart`). Ölçekleme yeni ReplicaSet açmaz.
Pod'ların image etiketlerinden ReplicaSet'in hangi image'ı çalıştırdığı bulunur:
  - image öncekiyle farklı → yeni sürüm
  - image aynı → yeniden başlatma / ayar değişikliği
Not: Kubernetes her deployment için son ~10 ReplicaSet'i tutar; daha eski değişiklikler görünmez.
"""
from __future__ import annotations

import asyncio
import re
import time
from collections import Counter, defaultdict
from typing import Any

from . import config, grafana
from .analysis import TZ, local

BATCH_GAP_S = 5 * 60          # bu kadar yakın değişiklikler tek "parti" sayılır
MASS_MIN = 5                  # bir partide bu kadar deployment varsa "toplu"
PATTERN_MIN_DAYS = 5          # aynı saatte en az bu kadar gün tekrar ederse "zamanlı"
BEFORE_INCIDENT_S = 60 * 60   # olaydan önce bakılan süre


def _tag(image: str) -> str:
    return image.split("/")[-1]


def _version(tag: str) -> str:
    """'repo:0.0.29-b5ad4bf158…' → '0.0.29 · b5ad4bf'"""
    t = tag.split(":", 1)[-1]
    m = re.match(r"^(.*?)-([0-9a-f]{7,40})(?:-(.*))?$", t)
    if m:
        return f"{m.group(1)} · {m.group(2)[:7]}" + (f" · {m.group(3)}" if m.group(3) else "")
    return t


async def collect() -> dict[str, Any]:
    window = f"{config.WINDOW_DAYS}d"
    rs_res, pod_res = await asyncio.gather(
        grafana.prom(
            f'kube_replicaset_created * on (namespace, replicaset) group_left (owner_name) '
            f'kube_replicaset_owner{{owner_kind="Deployment"}} > (time() - {config.WINDOW_DAYS} * 86400)'
        ),
        grafana.prom(f"count by (namespace, pod, image) (last_over_time(kube_pod_container_info[{window}]))"),
    )
    images: dict[tuple[str, str], set[str]] = defaultdict(set)
    for p in pod_res:
        m = p["metric"]
        rs = m.get("pod", "").rsplit("-", 1)[0]
        if m.get("image"):
            images[(m.get("namespace", ""), rs)].add(_tag(m["image"]))

    per_dep: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rs_res:
        m = r["metric"]
        ns, rs = m.get("namespace", ""), m.get("replicaset", "")
        dep = m.get("owner_name") or rs.rsplit("-", 1)[0]
        per_dep[(ns, dep)].append({"t": int(float(r["value"][1])), "namespace": ns, "deployment": dep, "replicaset": rs,
                                   "images": sorted(images.get((ns, rs), []))})

    events: list[dict] = []
    patterns: list[dict] = []
    for (ns, dep), items in per_dep.items():
        items.sort(key=lambda x: x["t"])
        run_start = None  # şu an çalışan image'ın prod'a ilk geldiği an
        run_exact = False  # False: görünen en eski kayıt; sürüm aslında daha önce gelmiş olabilir
        for i, e in enumerate(items):
            prev = items[i - 1]["images"] if i else None
            if prev is None:
                kind = "unknown"  # pencerenin ilk kaydı: öncesini bilmiyoruz
            elif e["images"] and prev and e["images"] != prev:
                kind = "release"
            else:
                kind = "restart"
            e["kind"] = kind
            e["version"] = " + ".join(_version(x) for x in e["images"][:2]) if e["images"] else None
            e["prev_version"] = " + ".join(_version(x) for x in prev[:2]) if prev else None
            e["t_ms"] = e["t"] * 1000
            e["prev_since_ms"] = run_start * 1000 if (kind == "release" and run_start is not None) else None
            e["prev_since_exact"] = run_exact if kind == "release" else None
            if kind != "restart" or run_start is None:
                run_start, run_exact = e["t"], kind == "release"
            events.append(e)
        # Her gün aynı saatte (10 dk dilim) tekrar eden değişiklik
        slots = Counter()
        days_by_slot: dict[str, set] = defaultdict(set)
        for e in items:
            lt = local(e["t_ms"])
            slot = f"{lt.hour:02d}:{lt.minute // 10 * 10:02d}"
            days_by_slot[slot].add(lt.date())
        for slot, days in days_by_slot.items():
            if len(days) >= PATTERN_MIN_DAYS:
                patterns.append({"namespace": ns, "deployment": dep, "time": slot, "days": len(days)})

    events.sort(key=lambda e: e["t"])
    batches: list[dict] = []
    for e in events:
        if batches and e["t"] - batches[-1]["end"] <= BATCH_GAP_S:
            b = batches[-1]
            b["events"].append(e)
            b["end"] = e["t"]
        else:
            batches.append({"start": e["t"], "end": e["t"], "events": [e]})
    out_batches = []
    for b in batches:
        kinds = Counter(e["kind"] for e in b["events"])
        n = len({(e["namespace"], e["deployment"]) for e in b["events"]})
        out_batches.append({
            "id": f"{b['start']}", "start": b["start"] * 1000, "end": b["end"] * 1000, "deployments": n,
            "releases": kinds["release"], "restarts": kinds["restart"], "unknown": kinds["unknown"],
            "mass": n >= MASS_MIN,
            "items": [{k: e[k] for k in ("namespace", "deployment", "kind", "version", "prev_version", "prev_since_ms", "prev_since_exact", "t_ms")} for e in b["events"]],
        })
    out_batches.reverse()

    # Ortak zamanlı restart: aynı saat diliminde birden çok deployment
    by_slot: dict[str, list] = defaultdict(list)
    for p in patterns:
        by_slot[p["time"]].append(p)
    schedules = sorted(({"time": t, "deployments": len(ps), "days": max(p["days"] for p in ps),
                         "names": sorted(f"{p['namespace']}/{p['deployment']}" for p in ps)} for t, ps in by_slot.items()),
                       key=lambda s: -s["deployments"])
    return {
        "fetched_at": int(time.time() * 1000),
        "stats": {"releases": sum(b["releases"] for b in out_batches), "restarts": sum(b["restarts"] for b in out_batches),
                  "batches": len(out_batches), "mass": sum(b["mass"] for b in out_batches),
                  "deployments": len(per_dep)},
        "batches": out_batches,
        "schedules": schedules,
    }


# ------------------------------------------------------------- olaylarla ilişki
def _tokens(s: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", s.lower()) if len(t) >= 4 and t not in {"prod", "deployment", "backend", "comm", "warning", "critical"}}


def relevant(item: dict, labels: dict[str, str], titles: list[str]) -> bool:
    """Değişiklik olayla doğrudan ilişkili mi? (aynı namespace ya da servis adı geçiyor)"""
    if labels.get("namespace") and labels["namespace"] == item["namespace"]:
        return True
    dep = _tokens(item["deployment"])
    ctx = _tokens(" ".join(list(labels.values()) + titles))
    return bool(dep & ctx)


def for_incident(ch: dict, start_ms: int, labels_list: list[dict[str, str]], titles: list[str]) -> list[dict]:
    lo, hi = start_ms - BEFORE_INCIDENT_S * 1000, start_ms + 60_000
    out = []
    for b in ch.get("batches", []):
        if b["end"] < lo or b["start"] > hi:
            continue
        items = [i for i in b["items"] if lo <= i["t_ms"] <= hi]
        if not items:
            continue
        rel = [i for i in items if any(relevant(i, l, titles) for l in labels_list or [{}])]
        out.append({**{k: b[k] for k in ("id", "start", "end", "deployments", "releases", "restarts", "mass")},
                    "minutes_before": round((start_ms - b["start"]) / 60000), "related": len(rel) > 0,
                    "items": rel + [i for i in items if i not in rel]})
    return out


def incidents_after(ch: dict, incidents: list[dict]) -> dict[str, list[str]]:
    """Her değişiklik partisinden sonraki 60 dk içinde başlayan olay id'leri."""
    out: dict[str, list[str]] = {}
    for b in ch.get("batches", []):
        hi = b["end"] + BEFORE_INCIDENT_S * 1000
        out[b["id"]] = [i["id"] for i in incidents if b["start"] <= i["start"] <= hi]
    return out
