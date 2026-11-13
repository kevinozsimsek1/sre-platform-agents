"""Prod'daki değişiklikler (yeni sürüm / yeniden başlatma / geri alma) ve olaylarla ilişkisi.

Kaynak: kube-state-metrics (Prometheus) pod kayıtları. Bir deployment'ta çalışan pod'ların sahibi olan
ReplicaSet değiştiği an bir değişikliktir:
  - yeni ReplicaSet, image farklı  → yeni sürüm
  - yeni ReplicaSet, image aynı    → yeniden başlatma / ayar değişikliği
  - daha önce aktif olmuş (ya da daha eski) bir ReplicaSet'e dönüş → geri alma (rollback)
Ölçekleme (HPA, node değişimi) yeni ReplicaSet açmaz; aynı sahibin yeni pod'u değişiklik sayılmaz.

Neden ReplicaSet'in yaratılış zamanı değil de pod'lar: Kubernetes her deployment için son ~10 ReplicaSet'i
tutar (günlük restart'ı olan serviste ~10 gün), geri almada ise yeni ReplicaSet açmaz. Pod kayıtları
Prometheus'un sakladığı sürece (pencere) geriye gider ve geri almada da yeni pod açılır. Ölçüm: pod'un
açılışı ReplicaSet'in yaratılışından en fazla 2 sn sonra.

Sınır: pencereden (WINDOW_DAYS) eskisi görünmez. Bir sürümün başlangıcı pencerede görünmüyorsa tarih
"en az … beri" olarak verilir (prev_since_exact=False); pencere başında zaten çalışan sürüm olay sayılmaz.
"""
from __future__ import annotations

import asyncio
import re
import time
from collections import Counter, defaultdict
from typing import Any

from . import config, grafana
from .analysis import local

BATCH_GAP_S = 5 * 60          # bu kadar yakın değişiklikler tek "parti" sayılır
MASS_MIN = 5                  # bir partide bu kadar deployment varsa "toplu"
PATTERN_MIN_DAYS = 5          # aynı saatte en az bu kadar gün tekrar ederse "zamanlı"
BEFORE_INCIDENT_S = 60 * 60   # olaydan önce bakılan süre

ITEM_KEYS = ("namespace", "deployment", "replicaset", "kind", "version", "prev_version", "prev_since_ms", "prev_since_exact", "t_ms")


def _tag(image: str) -> str:
    return image.split("/")[-1]


def _version(tag: str) -> str:
    """'repo:0.0.29-b5ad4bf158…' → '0.0.29 · b5ad4bf'"""
    t = tag.split(":", 1)[-1]
    m = re.match(r"^(.*?)-([0-9a-f]{7,40})(?:-(.*))?$", t)
    if m:
        return f"{m.group(1)} · {m.group(2)[:7]}" + (f" · {m.group(3)}" if m.group(3) else "")
    return t


def _ver_str(images: frozenset[str] | None) -> str | None:
    return " + ".join(_version(x) for x in sorted(images)[:2]) if images else None


def _rs_dep(rs: str) -> str:
    """ReplicaSet adı 'deployment-<hash>'; hash'te tire olmaz."""
    return rs.rsplit("-", 1)[0]


def walk(pods: list[dict], rs_created: dict[str, int] | None = None, *, brand_new: bool = False) -> list[dict]:
    """Tek bir deployment'ın pod'larından değişiklik olayları (saf fonksiyon; test edilebilir).

    pods: [{"t": epoch_s, "replicaset": ad, "images": frozenset}], sırasız olabilir.
    rs_created: bilinen ReplicaSet yaratılış zamanları (geri almayı, pod'u pencerede görünmeyen RS için de yakalamak için).
    brand_new: deployment'ın kendisi pencere içinde yaratıldı → ilk pod'u "yeni deployment" olayıdır (öncesi yok).
    Döner: [{"t", "replicaset", "kind", "images", "prev_images", "prev_since", "prev_since_exact"}]
    """
    rs_created = rs_created or {}
    rs_images: dict[str, set[str]] = defaultdict(set)
    for p in pods:
        rs_images[p["replicaset"]].update(p["images"])
    events: list[dict] = []
    cur: str | None = None
    cur_img: frozenset[str] = frozenset()
    seen: set[str] = set()
    ver_start: int | None = None   # şu an çalışan sürümün (image kümesinin) başlangıcı
    ver_exact = False               # başlangıca geçiş görüldü mü, yoksa görünen en eski kayıt mı
    for p in sorted(pods, key=lambda x: (x["t"], x["replicaset"])):
        rs = p["replicaset"]
        if rs == cur:
            continue
        img = frozenset(rs_images[rs])
        if cur is None:
            if brand_new:
                # Deployment prod'a ilk kez çıkıyor: öncesi yok, başlangıcı kesin.
                events.append({"t": p["t"], "replicaset": rs, "kind": "new", "images": img, "prev_images": frozenset(),
                               "prev_since": None, "prev_since_exact": None})
                cur, cur_img, ver_start, ver_exact = rs, img, p["t"], True
            else:
                # Pencere başında zaten çalışan sürüm: olay değil, sadece başlangıç bilgisi.
                cur, cur_img, ver_start, ver_exact = rs, img, p["t"], False
            seen.add(rs)
            continue
        older = rs in seen or (rs in rs_created and cur in rs_created and rs_created[rs] < rs_created[cur])
        if not img or not cur_img:
            kind = "unknown"
        elif older:
            kind = "rollback"
        elif img != cur_img:
            kind = "release"
        else:
            kind = "restart"
        events.append({"t": p["t"], "replicaset": rs, "kind": kind, "images": img, "prev_images": cur_img,
                       "prev_since": ver_start, "prev_since_exact": ver_exact})
        if kind != "restart":
            ver_start, ver_exact = p["t"], kind != "unknown"
        cur, cur_img = rs, img
        seen.add(rs)
    return events


async def _pods(window: str) -> list[dict]:
    """Pencerede yaşamış (pencereden önce açılmış olsa da) ReplicaSet pod'ları: açılış, sahip, image'lar."""
    created, owner, info = await asyncio.gather(
        grafana.prom(f"last_over_time(kube_pod_created[{window}])"),
        grafana.prom(f'last_over_time(kube_pod_owner{{owner_kind="ReplicaSet"}}[{window}])'),
        grafana.prom(f"count by (namespace, pod, image, image_spec) (last_over_time(kube_pod_container_info[{window}]))"),
    )
    imgs: dict[tuple[str, str], set[str]] = defaultdict(set)
    for r in info:
        m = r["metric"]
        img = m.get("image_spec") or m.get("image")
        if img:
            imgs[(m.get("namespace", ""), m.get("pod", ""))].add(_tag(img))
    t = {(r["metric"].get("namespace", ""), r["metric"].get("pod", "")): int(float(r["value"][1])) for r in created}
    out = []
    for r in owner:
        m = r["metric"]
        key = (m.get("namespace", ""), m.get("pod", ""))
        if key not in t or not m.get("owner_name"):
            continue
        out.append({"t": t[key], "namespace": key[0], "pod": key[1], "replicaset": m["owner_name"], "images": frozenset(imgs.get(key, ()))})
    return out


async def collect() -> dict[str, Any]:
    window = f"{config.WINDOW_DAYS}d"
    since = int(time.time()) - config.WINDOW_DAYS * 86400
    pods, rs_res, active_res, dep_res = await asyncio.gather(
        _pods(window),
        grafana.prom('kube_replicaset_created * on (namespace, replicaset) group_left (owner_name) kube_replicaset_owner{owner_kind="Deployment"}'),
        grafana.prom("kube_replicaset_spec_replicas > 0"),
        grafana.prom("kube_deployment_created"),
    )
    dep_created = {(r["metric"].get("namespace", ""), r["metric"].get("deployment", "")): int(float(r["value"][1])) for r in dep_res}
    rs_created: dict[tuple[str, str], int] = {}
    rs_owner: dict[tuple[str, str], str] = {}
    for r in rs_res:
        m = r["metric"]
        key = (m.get("namespace", ""), m.get("replicaset", ""))
        rs_created[key] = int(float(r["value"][1]))
        rs_owner[key] = m.get("owner_name") or _rs_dep(key[1])

    by_dep: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for p in pods:
        key = (p["namespace"], p["replicaset"])
        by_dep[(p["namespace"], rs_owner.get(key) or _rs_dep(p["replicaset"]))].append(p)

    events: list[dict] = []
    patterns: list[dict] = []
    for (ns, dep), plist in by_dep.items():
        created = {rs: t for (n, rs), t in rs_created.items() if n == ns}
        brand_new = dep_created.get((ns, dep), 0) >= since
        evs = [e for e in walk(plist, created, brand_new=brand_new) if e["t"] >= since]
        for e in evs:
            events.append({
                "t": e["t"], "t_ms": e["t"] * 1000, "namespace": ns, "deployment": dep, "replicaset": e["replicaset"], "kind": e["kind"],
                "version": _ver_str(e["images"]), "prev_version": _ver_str(e["prev_images"]),
                "prev_since_ms": e["prev_since"] * 1000 if e["kind"] in ("release", "rollback") and e["prev_since"] is not None else None,
                "prev_since_exact": e["prev_since_exact"] if e["kind"] in ("release", "rollback") else None,
            })
        # Her gün aynı saatte (10 dk dilim) tekrar eden değişiklik
        days_by_slot: dict[str, set] = defaultdict(set)
        for e in evs:
            lt = local(e["t"] * 1000)
            days_by_slot[f"{lt.hour:02d}:{lt.minute // 10 * 10:02d}"].add(lt.date())
        for slot, days in days_by_slot.items():
            if len(days) >= PATTERN_MIN_DAYS:
                patterns.append({"namespace": ns, "deployment": dep, "time": slot, "days": len(days)})

    events.sort(key=lambda e: (e["t"], e["namespace"], e["deployment"]))
    batches: list[dict] = []
    for e in events:
        if batches and e["t"] - batches[-1]["end"] <= BATCH_GAP_S:
            batches[-1]["events"].append(e)
            batches[-1]["end"] = e["t"]
        else:
            batches.append({"start": e["t"], "end": e["t"], "events": [e]})
    out_batches = []
    for b in batches:
        kinds = Counter(e["kind"] for e in b["events"])
        n = len({(e["namespace"], e["deployment"]) for e in b["events"]})
        out_batches.append({
            "id": f"{b['start']}", "start": b["start"] * 1000, "end": b["end"] * 1000, "deployments": n,
            "releases": kinds["release"], "restarts": kinds["restart"], "rollbacks": kinds["rollback"], "new": kinds["new"], "unknown": kinds["unknown"],
            "mass": n >= MASS_MIN,
            "items": [{k: e[k] for k in ITEM_KEYS} for e in b["events"]],
        })
    out_batches.reverse()

    # Şu an en yeni ReplicaSet'i değil, daha eskisini çalıştıran deployment'lar (geri alınmış durumda)
    active = {(r["metric"].get("namespace", ""), r["metric"].get("replicaset", "")) for r in active_res}
    newest: dict[tuple[str, str], tuple[int, str]] = {}
    running: dict[tuple[str, str], list[str]] = defaultdict(list)
    for key, t in rs_created.items():
        dk = (key[0], rs_owner[key])
        if dk not in newest or t > newest[dk][0]:
            newest[dk] = (t, key[1])
        if key in active:
            running[dk].append(key[1])
    rolled_back = sorted({"namespace": dk[0], "deployment": dk[1], "running": rs_list, "newest": newest[dk][1]}
                         for dk, rs_list in running.items() if newest[dk][1] not in rs_list) if running else []
    rolled_back = sorted(rolled_back, key=lambda x: (x["namespace"], x["deployment"]))

    # Ortak zamanlı restart: aynı saat diliminde birden çok deployment
    by_slot: dict[str, list] = defaultdict(list)
    for p in patterns:
        by_slot[p["time"]].append(p)
    schedules = sorted(({"time": t, "deployments": len(ps), "days": max(p["days"] for p in ps),
                         "names": sorted(f"{p['namespace']}/{p['deployment']}" for p in ps)} for t, ps in by_slot.items()),
                       key=lambda s: -s["deployments"])
    return {
        "fetched_at": int(time.time() * 1000),
        "window_days": config.WINDOW_DAYS,
        "stats": {"releases": sum(b["releases"] for b in out_batches), "restarts": sum(b["restarts"] for b in out_batches),
                  "rollbacks": sum(b["rollbacks"] for b in out_batches), "new": sum(b["new"] for b in out_batches),
                  "unknown": sum(b["unknown"] for b in out_batches),
                  "batches": len(out_batches), "mass": sum(b["mass"] for b in out_batches),
                  "deployments": len({(e["namespace"], e["deployment"]) for e in events})},
        "batches": out_batches,
        "schedules": schedules,
        "rolled_back": rolled_back,
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
        out.append({**{k: b[k] for k in ("id", "start", "end", "deployments", "releases", "restarts", "rollbacks", "new", "mass")},
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
