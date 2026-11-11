"""Alert verisinin modeli: Grafana'dan ham veriyi çeker, kural/olay/nöbet istatistiklerini hesaplar.

Bulgular (findings) elle yazılmaz; her biri açık bir eşik kuralıyla veriden çıkarılır. Eşikler
bu dosyanın başında durur ki ekip neye göre işaretlendiğini görebilsin ve değiştirebilsin.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import statistics
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from . import config, grafana, investigate

TZ = timezone(timedelta(hours=config.TZ_OFFSET_HOURS))
DAY_MS = 86_400_000

# Bulgu eşikleri
BROKEN_MIN_ERRORS = 20
NODATA_MIN = 50
FLAP_MIN_FIRES, FLAP_SHORT_SHARE, SHORT_MIN = 8, 0.6, 10
SCHED_MIN_FIRES, SCHED_HOUR_SHARE = 8, 0.5
LONG_OPEN_HOURS = 24
OFFHOURS_MIN_FIRES, OFFHOURS_SHARE = 10, 0.8

SEV_RANK = {"critical": 2, "warning": 1}


# ---------------------------------------------------------------- yardımcılar
def local(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, TZ)


def is_offhours(ms: int) -> bool:
    t = local(ms)
    return t.weekday() >= 5 or t.hour < config.WORK_START or t.hour >= config.WORK_END


def is_night(ms: int) -> bool:
    return local(ms).hour < config.NIGHT_END


def base_state(s: str) -> str:
    return s.split(" (")[0]


def parse_dur(s: str | None) -> float:
    """'5m', '1h30m', '30s' → dakika."""
    if not s:
        return 0.0
    total = 0.0
    for n, u in re.findall(r"(\d+(?:\.\d+)?)([smhd])", s):
        total += float(n) * {"s": 1 / 60, "m": 1, "h": 60, "d": 1440}[u]
    return total


_LABELS_RE = re.compile(r"^.*?\{(.*)\}(?: - (.*))?$", re.S)


def parse_text(text: str) -> tuple[dict[str, str], str]:
    m = _LABELS_RE.match(text or "")
    if not m:
        return {}, ""
    labels = {}
    for part in re.split(r", (?=[A-Za-z_][A-Za-z0-9_]*=)", m.group(1)):
        if "=" in part:
            k, v = part.split("=", 1)
            labels[k.strip()] = v.strip()
    return labels, (m.group(2) or "").strip()


SERIES_SKIP = {"alertname", "grafana_folder", "severity", "alert_family", "layer"}


def series_key(labels: dict[str, str]) -> str:
    parts = [f"{k}={v}" for k, v in sorted(labels.items()) if k not in SERIES_SKIP]
    return ", ".join(parts) or "(tek seri)"


def pct(a: float, b: float) -> float:
    return round(100 * a / b, 1) if b else 0.0


# ---------------------------------------------------------------- ham veri
async def fetch_raw() -> dict[str, Any]:
    now = int(time.time() * 1000)
    start = now - config.WINDOW_DAYS * DAY_MS

    async def per_org(org: int) -> dict[str, Any]:
        rules, folders, ruler, policies, cps, dss = await asyncio.gather(
            grafana.get("/api/v1/provisioning/alert-rules", org),
            grafana.get("/api/folders", org, {"limit": 1000}),
            grafana.get("/api/prometheus/grafana/api/v1/rules", org),
            grafana.get("/api/v1/provisioning/policies", org),
            grafana.get("/api/v1/provisioning/contact-points", org),
            grafana.get("/api/datasources", org),
        )

        async def window(a: int, b: int) -> list[dict]:
            return await grafana.get("/api/annotations", org, {"type": "alert", "from": a, "to": b, "limit": 5000})

        chunks = await asyncio.gather(*[window(a, min(a + DAY_MS, now)) for a in range(start, now, DAY_MS)])
        ann = {x["id"]: x for c in chunks for x in c}
        return {
            "org": org,
            "rules": rules,
            "folders": {f["uid"]: f["title"] for f in folders},
            "ruler": ruler,
            "policies": policies,
            # Contact point ayarlarında webhook URL'leri olabilir: sadece ad ve tip tutulur.
            "contact_points": {c["name"]: c["type"] for c in cps},
            "datasources": {d["uid"]: {"name": d["name"], "type": d["type"]} for d in dss},
            "annotations": sorted(ann.values(), key=lambda x: x["time"]),
        }

    orgs = await asyncio.gather(*[per_org(o) for o in config.GRAFANA_ORGS])
    return {"fetched_at": now, "start": start, "orgs": orgs}


# ---------------------------------------------------------------- model
@dataclass
class Episode:
    org: int
    uid: str
    title: str
    series: str
    labels: dict[str, str]
    start: int
    end: int | None
    value: str
    kind: str = "firing"  # firing | error

    @property
    def minutes(self) -> float:
        return ((self.end or int(time.time() * 1000)) - self.start) / 60000


@dataclass
class RuleModel:
    org: int
    uid: str
    title: str
    folder: str
    group: str
    severity: str | None
    for_: str
    paused: bool
    labels: dict[str, str]
    annotations: dict[str, str]
    raw: dict[str, Any]
    exec_err_state: str | None
    no_data_state: str | None
    episodes: list[Episode] = field(default_factory=list)
    errors: list[Episode] = field(default_factory=list)
    nodata: int = 0
    nearmiss: int = 0
    error_msgs: Counter = field(default_factory=Counter)
    state: str = "unknown"
    health: str | None = None
    last_error: str | None = None
    active: list[dict] = field(default_factory=list)
    findings: list[dict] = field(default_factory=list)
    signature: str = ""

    @property
    def key(self) -> str:
        return f"{self.org}:{self.uid}"

    @property
    def fires(self) -> int:
        return len(self.episodes)

    def durations(self) -> list[float]:
        return [e.minutes for e in self.episodes if e.end]


class Model:
    def __init__(self, raw: dict[str, Any]):
        self.fetched_at = raw["fetched_at"]
        self.start = raw["start"]
        self.rules: dict[str, RuleModel] = {}
        self.by_title: dict[tuple[int, str], RuleModel] = {}
        self.policies: dict[int, dict] = {}
        self.contact_points: dict[int, dict[str, str]] = {}
        self.datasources: dict[str, dict] = {}
        for o in raw["orgs"]:
            self._load_org(o)
        self._signatures()
        for r in self.rules.values():
            r.findings = self._findings(r)
        self.incidents = self._incidents()

    # -- yükleme
    def _load_org(self, o: dict[str, Any]) -> None:
        org = o["org"]
        self.policies[org] = o["policies"]
        self.contact_points[org] = o["contact_points"]
        self.datasources.update(o["datasources"])
        for r in o["rules"]:
            m = RuleModel(
                org=org, uid=r["uid"], title=r["title"], folder=o["folders"].get(r.get("folderUID"), "—"),
                group=r.get("ruleGroup", ""), severity=(r.get("labels") or {}).get("severity"), for_=r.get("for") or "0s",
                paused=bool(r.get("isPaused")), labels=r.get("labels") or {}, annotations=r.get("annotations") or {},
                raw=r, exec_err_state=r.get("execErrState"), no_data_state=r.get("noDataState"),
            )
            self.rules[m.key] = m
            self.by_title[(org, m.title)] = m
        for g in o["ruler"].get("data", {}).get("groups", []):
            for rr in g.get("rules", []):
                m = self.by_title.get((org, rr.get("name")))
                if not m:
                    continue
                m.state, m.health, m.last_error = rr.get("state", "unknown"), rr.get("health"), rr.get("lastError") or None
                m.active = [
                    {"labels": a.get("labels", {}), "state": a.get("state"), "since": a.get("activeAt"), "value": a.get("value")}
                    for a in rr.get("alerts", []) or []
                ]
        self._episodes(org, o["annotations"])

    def _episodes(self, org: int, anns: list[dict]) -> None:
        open_fire: dict[tuple[str, str], Episode] = {}
        open_err: dict[tuple[str, str], Episode] = {}
        for a in anns:
            m = self.by_title.get((org, a.get("alertName")))
            if not m:
                continue
            labels, value = parse_text(a.get("text", ""))
            s = series_key(labels)
            k = (m.uid, s)
            new, prev = base_state(a["newState"]), base_state(a["prevState"])
            t = a["time"]
            if new == "Alerting" and prev != "Alerting":
                open_fire[k] = Episode(org, m.uid, m.title, s, labels, t, None, value)
                m.episodes.append(open_fire[k])
            elif prev == "Alerting" and new != "Alerting" and k in open_fire:
                open_fire.pop(k).end = t
            if new == "Error" and prev != "Error":
                err = (a.get("data") or {}).get("error") or "bilinmeyen hata"
                m.error_msgs[re.sub(r"\s+", " ", err)[:220]] += 1
                open_err[k] = Episode(org, m.uid, m.title, s, labels, t, None, err, kind="error")
                m.errors.append(open_err[k])
            elif prev == "Error" and new != "Error" and k in open_err:
                open_err.pop(k).end = t
            if a["newState"] == "Normal (NoData)":
                m.nodata += 1
            if prev == "Pending" and new == "Normal":
                m.nearmiss += 1

    def _signatures(self) -> None:
        for r in self.rules.values():
            parts = []
            for d in r.raw.get("data", []):
                mo = d.get("model", {})
                keep = {k: mo.get(k) for k in ("expr", "expression", "namespace", "metricName", "dimensions", "statistic",
                                                "queryString", "type", "conditions", "reducer")}
                parts.append({"ds": d.get("datasourceUid"), "rt": d.get("relativeTimeRange"), **keep})
            r.signature = hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()

    # -- bulgular
    def _findings(self, r: RuleModel) -> list[dict]:
        out: list[dict] = []
        fires, durs = r.fires, r.durations()
        short = sum(1 for d in durs if d <= SHORT_MIN)
        errs = len(r.errors)
        saved = 0
        if errs >= BROKEN_MIN_ERRORS:
            msg, n = r.error_msgs.most_common(1)[0]
            first = min(e.start for e in r.errors)
            out.append(dict(code="broken", level="crit", title="Sorgu sürekli hata veriyor",
                            detail=f"{errs} kez Error durumuna geçti. En sık hata ({n} kez): {msg}. İlk hata: {local(first):%d.%m %H:%M}.",
                            suggestion="Veri kaynağını ve sorguyu düzeltin; düzeltilene kadar kuralı duraklatmayı düşünün.",
                            impact={"errors": errs, "fires": fires}))
        elif r.nodata >= NODATA_MIN:
            out.append(dict(code="nodata", level="warn", title="Sorgu sık sık veri döndürmüyor",
                            detail=f"{r.nodata} kez NoData durumuna geçti. Bu sürede kural fiilen hiçbir şeyi izlemiyor.",
                            suggestion="Metrik adını, boyutları (dimensions) ve sorgu aralığını kontrol edin.",
                            impact={"errors": 0, "fires": 0}))
        if fires >= FLAP_MIN_FIRES and durs and short / len(durs) >= FLAP_SHORT_SHARE:
            for_min = parse_dur(r.for_)
            target = 5.0 if for_min < 5 else for_min * 2
            saved = sum(1 for d in durs if d < target - for_min)
        if fires >= FLAP_MIN_FIRES and durs and short / len(durs) >= FLAP_SHORT_SHARE and saved > 0:
            out.append(dict(code="flapping", level="warn", title="Titrek: çoğu tetiklenme kendiliğinden kısa sürede düzeliyor",
                            detail=f"{fires} tetiklenmenin {short}'i (%{pct(short, len(durs)):.0f}) {SHORT_MIN} dakikadan kısa sürdü. "
                                   f"Ortanca süre {statistics.median(durs):.1f} dk, bekleme süresi (for) {r.for_}.",
                            suggestion=f"for değerini {int(target)} dakikaya çıkarın; geçmiş veriye göre yaklaşık {saved} tetiklenme önlenirdi.",
                            impact={"errors": 0, "fires": saved}))
        if fires >= SCHED_MIN_FIRES:
            hours = Counter(local(e.start).hour for e in r.episodes)
            h, n = hours.most_common(1)[0]
            if n / fires >= SCHED_HOUR_SHARE:
                out.append(dict(code="scheduled", level="warn", title=f"Her gün aynı saatte tetikleniyor ({h:02d}:00)",
                                detail=f"{fires} tetiklenmenin {n}'i (%{pct(n, fires):.0f}) {h:02d}:00–{h:02d}:59 arasında başladı. "
                                       "Bu, zamanlanmış bir iş (batch, cron, yedekleme) gibi görünüyor.",
                                suggestion="Beklenen bir işse bu saat için mute timing tanımlayın ya da ilgili kaynağı kuraldan hariç tutun.",
                                impact={"errors": 0, "fires": n}))
        twins = [o for o in self.rules.values() if o is not r and o.signature == r.signature]
        if twins:
            names = ", ".join(o.title for o in twins)
            sev_pair = any(o.severity != r.severity for o in twins)
            out.append(dict(code="duplicate", level="warn",
                            title="Warning ve Critical aynı eşikte" if sev_pair else "Birebir kopya kural",
                            detail=f"Şu kural(lar)la aynı sorgu ve aynı eşik: {names}. Her olayda alert'ler birlikte gelir.",
                            suggestion="Critical eşiğini Warning'den ayırın ya da kopyayı silin.",
                            impact={"errors": 0, "fires": fires if (sev_pair and r.severity == "warning") or not sev_pair else 0}))
        tl = r.title.lower()
        if (("warning" in tl or "warn" in tl) and r.severity == "critical") or ("critical" in tl and r.severity == "warning"):
            out.append(dict(code="severity", level="info", title="Ad ile seviye uyuşmuyor",
                            detail=f"Kuralın adı '{r.title}' ama severity etiketi '{r.severity}'. Alert beklenenden farklı kanala gider.",
                            suggestion="severity etiketini kuralın adıyla uyumlu hale getirin.", impact={"errors": 0, "fires": 0}))
        if "(copy)" in tl:
            out.append(dict(code="copy", level="info", title="Kopya adı taşıyor",
                            detail="Kural adı '(copy)' içeriyor; büyük ihtimalle başka bir kuraldan kopyalanıp unutulmuş.",
                            suggestion="Gerekli değilse silin, gerekliyse anlamlı bir ad verin.", impact={"errors": 0, "fires": 0}))
        now = int(time.time() * 1000)
        long_open = [e for e in r.episodes if e.end is None and now - e.start > LONG_OPEN_HOURS * 3_600_000]
        if long_open:
            oldest = min(e.start for e in long_open)
            out.append(dict(code="long_open", level="warn", title=f"{len(long_open)} seri {LONG_OPEN_HOURS} saatten uzun süredir açık",
                            detail=f"En eskisi {local(oldest):%d.%m %H:%M}'den beri Alerting. Uzun süre açık kalan alert'e bakılmıyorsa gürültüye dönüşür.",
                            suggestion="Ya sorunu kapatın ya da bu ortam için alert'in gerekli olup olmadığına karar verin.",
                            impact={"errors": 0, "fires": 0}))
        if fires >= OFFHOURS_MIN_FIRES:
            off = sum(1 for e in r.episodes if is_offhours(e.start))
            if off / fires >= OFFHOURS_SHARE:
                out.append(dict(code="offhours", level="info", title="Çoğunlukla mesai dışında tetikleniyor",
                                detail=f"{fires} tetiklenmenin {off}'i mesai dışında. Nöbetçiyi en çok rahatsız eden kurallardan biri.",
                                suggestion="Gerçekten gece müdahale gerektiriyor mu? Gerekmiyorsa seviyeyi düşürün.",
                                impact={"errors": 0, "fires": 0}))
        if r.paused:
            out.append(dict(code="paused", level="info", title="Kural duraklatılmış",
                            detail="Bu kural şu an değerlendirilmiyor; izlendiği sanılan alan aslında izlenmiyor.",
                            suggestion="Düzeltip açın ya da silin.", impact={"errors": 0, "fires": 0}))
        return out

    # -- olaylar
    def _incidents(self) -> list[dict]:
        gap = config.INCIDENT_GAP_MIN * 60_000
        now = int(time.time() * 1000)
        eps = sorted((e for r in self.rules.values() for e in r.episodes), key=lambda e: e.start)
        groups: list[list[Episode]] = []
        cur_end = -1
        for e in eps:
            end = e.end or now
            if groups and e.start <= cur_end + gap:
                groups[-1].append(e)
                cur_end = max(cur_end, end)
            else:
                groups.append([e])
                cur_end = end
        out = []
        for g in groups:
            start = g[0].start
            ongoing = any(e.end is None for e in g)
            end = None if ongoing else max(e.end for e in g)  # type: ignore[type-var]
            rules = {}
            for e in g:
                r = self.rules[f"{e.org}:{e.uid}"]
                rules.setdefault(r.key, r)
            sev = max((SEV_RANK.get(r.severity or "", 0) for r in rules.values()), default=0)
            noisy_codes = {"flapping", "broken", "scheduled", "duplicate"}
            preventable = all(any(f["code"] in noisy_codes for f in r.findings) for r in rules.values())
            iid = local(start).strftime("%y%m%d-%H%M") + "-" + hashlib.sha1(g[0].uid.encode()).hexdigest()[:4]
            out.append({
                "id": iid, "start": start, "end": end, "ongoing": ongoing,
                "minutes": round(((end or now) - start) / 60000, 1),
                "severity": {2: "critical", 1: "warning"}.get(sev, "none"),
                "rules": [{"key": r.key, "org": r.org, "uid": r.uid, "title": r.title, "severity": r.severity} for r in rules.values()],
                "episodes": len(g), "series": len({(e.uid, e.series) for e in g}),
                "offhours": is_offhours(start), "night": is_night(start), "preventable": preventable,
                "_eps": g,
            })
        out.reverse()
        return out

    # -- yönlendirme
    def route(self, r: RuleModel) -> list[dict]:
        labels = {**r.labels, "alertname": r.title, "grafana_folder": r.folder}
        root = self.policies.get(r.org) or {}

        def ok(route: dict) -> bool:
            for name, op, val in route.get("object_matchers") or []:
                v = labels.get(name, "")
                if op == "=" and v != val or op == "!=" and v == val:
                    return False
                if op == "=~" and not re.fullmatch(val, v) or op == "!~" and re.fullmatch(val, v):
                    return False
            return True

        def walk(route: dict, receiver: str | None) -> list[str]:
            receiver = route.get("receiver") or receiver
            hits: list[str] = []
            for child in route.get("routes") or []:
                if ok(child):
                    hits += walk(child, receiver)
                    if not child.get("continue"):
                        break
            return hits or ([receiver] if receiver else [])

        cps = self.contact_points.get(r.org, {})
        seen, out = set(), []
        for name in walk(root, None):
            if name not in seen:
                seen.add(name)
                out.append({"name": name, "type": cps.get(name, "?")})
        return out

    def queries(self, r: RuleModel) -> list[dict]:
        out = []
        cond = r.raw.get("condition")
        for d in r.raw.get("data", []):
            mo = d.get("model", {})
            ds = d.get("datasourceUid")
            item: dict[str, Any] = {"ref": d.get("refId"), "condition": d.get("refId") == cond}
            if ds == "__expr__":
                item["kind"] = f"ifade · {mo.get('type')}"
                ev = [c.get("evaluator") for c in mo.get("conditions") or [] if c.get("evaluator")]
                item["text"] = mo.get("expression") or ""
                if mo.get("type") in ("threshold", "classic_conditions") and ev:
                    item["text"] = f"{mo.get('expression')} {ev[0].get('type')} {ev[0].get('params')}"
                elif mo.get("type") == "reduce":
                    item["text"] = f"{mo.get('reducer')}({mo.get('expression')})"
            else:
                info = self.datasources.get(ds, {"name": ds, "type": "?"})
                item["kind"] = f"{info['type']} · {info['name']}"
                if mo.get("expr"):
                    item["text"] = mo["expr"]
                elif mo.get("queryString") or mo.get("expression"):
                    item["text"] = mo.get("queryString") or mo.get("expression")
                elif mo.get("metricName"):
                    dims = ", ".join(f"{k}={'|'.join(v) if isinstance(v, list) else v}" for k, v in (mo.get("dimensions") or {}).items())
                    item["text"] = f"{mo.get('namespace')} / {mo.get('metricName')} ({mo.get('statistic')}) {{{dims}}}"
                else:
                    item["text"] = json.dumps({k: v for k, v in mo.items() if k not in ("datasource", "refId")})[:300]
                rt = d.get("relativeTimeRange") or {}
                item["range"] = f"son {int(rt.get('from', 0)) // 60} dk"
            out.append(item)
        return out


# ---------------------------------------------------------------- API çıktıları
def rule_row(m: Model, r: RuleModel) -> dict:
    durs = r.durations()
    last = max((e.start for e in r.episodes), default=None)
    return {
        "key": r.key, "org": r.org, "uid": r.uid, "title": r.title.strip(), "folder": r.folder, "group": r.group,
        "severity": r.severity, "for": r.for_, "paused": r.paused, "state": r.state, "health": r.health,
        "fires": r.fires, "short": sum(1 for d in durs if d <= SHORT_MIN),
        "median": round(statistics.median(durs), 1) if durs else None,
        "offhours": sum(1 for e in r.episodes if is_offhours(e.start)), "errors": len(r.errors), "nodata": r.nodata,
        "findings": [{"code": f["code"], "level": f["level"]} for f in r.findings], "last_fired": last,
        "active": len(r.active),
    }


def summary(m: Model) -> dict:
    rules = list(m.rules.values())
    eps = [e for r in rules for e in r.episodes]
    errs = [e for r in rules for e in r.errors]
    durs = [e.minutes for e in eps if e.end]
    days: dict[str, dict] = {}
    d = local(m.start).date()
    while d <= local(m.fetched_at).date():
        days[d.isoformat()] = {"day": d.isoformat(), "fires": 0, "errors": 0}
        d += timedelta(days=1)
    for e in eps:
        days.setdefault(local(e.start).date().isoformat(), {"day": local(e.start).date().isoformat(), "fires": 0, "errors": 0})["fires"] += 1
    for e in errs:
        days.setdefault(local(e.start).date().isoformat(), {"day": local(e.start).date().isoformat(), "fires": 0, "errors": 0})["errors"] += 1
    hours = [0] * 24
    for e in eps:
        hours[local(e.start).hour] += 1
    by_fires = sorted((r.fires for r in rules), reverse=True)
    findings = []
    for r in rules:
        for f in r.findings:
            findings.append({**f, "rule": {"key": r.key, "org": r.org, "uid": r.uid, "title": r.title.strip(), "severity": r.severity}})
    order = {"crit": 0, "warn": 1, "info": 2}
    findings.sort(key=lambda f: (order[f["level"]], -(f["impact"]["fires"] * 10 + f["impact"]["errors"])))
    # Önlenebilir tetiklenme: her kural için bulguların tahmini etkisinin en büyüğü (bulgular örtüşebildiği için toplanmaz).
    avoidable = sum(min(r.fires, max((f["impact"]["fires"] for f in r.findings), default=0)) for r in rules)
    return {
        "window": {"start": m.start, "end": m.fetched_at, "days": config.WINDOW_DAYS},
        "fetched_at": m.fetched_at,
        "totals": {
            "rules": len(rules), "paused": sum(r.paused for r in rules), "silent": sum(1 for r in rules if not r.fires and not r.errors),
            "fires": len(eps), "errors": len(errs), "incidents": len(m.incidents),
            "short_pct": pct(sum(1 for x in durs if x <= SHORT_MIN), len(durs)),
            "offhours_pct": pct(sum(1 for e in eps if is_offhours(e.start)), len(eps)),
            "top5_pct": pct(sum(by_fires[:5]), len(eps)),
            "firing_now": sum(1 for r in rules if r.state == "firing"),
            "rules_with_findings": len({f["rule"]["key"] for f in findings if f["level"] != "info"}),
            "preventable_fires": avoidable,
        },
        "daily": list(days.values()),
        "hours": hours,
        "findings": findings,
        "rules": sorted((rule_row(m, r) for r in rules), key=lambda x: -(x["fires"] + x["errors"])),
    }


def rule_detail(m: Model, key: str) -> dict | None:
    r = m.rules.get(key)
    if not r:
        return None
    by_day: dict[str, dict] = defaultdict(lambda: {"fires": 0, "errors": 0})
    for e in r.episodes:
        by_day[local(e.start).date().isoformat()]["fires"] += 1
    for e in r.errors:
        by_day[local(e.start).date().isoformat()]["errors"] += 1
    days = []
    d = local(m.start).date()
    while d <= local(m.fetched_at).date():
        days.append({"day": d.isoformat(), **by_day.get(d.isoformat(), {"fires": 0, "errors": 0})})
        d += timedelta(days=1)
    hours = [0] * 24
    for e in r.episodes:
        hours[local(e.start).hour] += 1
    series: dict[str, dict] = {}
    for e in r.episodes:
        s = series.setdefault(e.series, {"series": e.series, "fires": 0, "minutes": 0.0, "last": 0})
        s["fires"] += 1
        s["minutes"] += e.minutes
        s["last"] = max(s["last"], e.start)
    durs = sorted(r.durations())
    buckets = [("< 2 dk", 0, 2), ("2–5 dk", 2, 5), ("5–10 dk", 5, 10), ("10–30 dk", 10, 30), ("30–60 dk", 30, 60), ("1–4 sa", 60, 240), ("> 4 sa", 240, 1e9)]
    dist = [{"label": l, "count": sum(1 for x in durs if a <= x < b)} for l, a, b in buckets]
    dash = r.annotations.get("__dashboardUid__")
    return {
        "rule": {**rule_row(m, r), "labels": r.labels,
                 "annotations": {k: v for k, v in r.annotations.items() if not k.startswith("__") and k != "dashboard_url"},
                 "exec_err_state": r.exec_err_state, "no_data_state": r.no_data_state, "last_error": r.last_error,
                 "nearmiss": r.nearmiss},
        "links": {"grafana": grafana.rule_url(r.org, r.uid), "panel": grafana.panel_url(r.org, dash, r.annotations.get("__panelId__"))},
        "routing": m.route(r),
        "queries": m.queries(r),
        "findings": r.findings,
        "active": r.active,
        "daily": days, "hours": hours, "durations": dist,
        "p50": round(statistics.median(durs), 1) if durs else None,
        "p90": round(durs[int(len(durs) * 0.9) - 1], 1) if len(durs) >= 10 else None,
        "series": sorted(({**s, "minutes": round(s["minutes"], 1)} for s in series.values()), key=lambda s: -s["fires"])[:50],
        "errors": [{"message": k, "count": v} for k, v in r.error_msgs.most_common(10)],
        "episodes": [ep_dict(e) for e in sorted(r.episodes, key=lambda e: -e.start)[:200]],
        "incidents": [inc_row(i) for i in m.incidents if any(x["key"] == r.key for x in i["rules"])][:50],
        "investigate": guide_for(m, r, None, None, None),
    }


PAD_BEFORE, PAD_AFTER = 30 * 60_000, 15 * 60_000


def guide_for(m: Model, r: RuleModel, labels: dict[str, str] | None, start: int | None, end: int | None) -> list[dict]:
    now = int(time.time() * 1000)
    if start is None:
        last = max(r.episodes, key=lambda e: e.start, default=None) or max(r.errors, key=lambda e: e.start, default=None)
        if last:
            start, end, labels = last.start, last.end, labels or last.labels
        else:
            start, end = now - 6 * 3_600_000, now
    return investigate.guide(r, m.datasources, labels or {}, start - PAD_BEFORE, min(now, (end or now) + PAD_AFTER))


def signals(m: Model, r: RuleModel) -> list[str]:
    out = [r.title, r.folder, " ".join(f"{k}={v}" for k, v in r.labels.items())]
    for q in m.queries(r):
        out += [q["kind"], q.get("text", "")]
    for e in r.episodes[-3:]:
        out.append(e.series)
    return out


def ep_dict(e: Episode) -> dict:
    return {"start": e.start, "end": e.end, "minutes": round(e.minutes, 1), "series": e.series, "value": e.value,
            "rule": {"key": f"{e.org}:{e.uid}", "title": e.title.strip()}, "offhours": is_offhours(e.start)}


def inc_row(i: dict) -> dict:
    return {k: v for k, v in i.items() if not k.startswith("_")}


def incident_detail(m: Model, iid: str) -> dict | None:
    i = next((x for x in m.incidents if x["id"] == iid), None)
    if not i:
        return None
    rules = [m.rules[x["key"]] for x in i["rules"]]
    related = []
    for r in rules:
        related += [{"rule": r.title.strip(), **f} for f in r.findings]
    return {**inc_row(i), "timeline": [ep_dict(e) for e in sorted(i["_eps"], key=lambda e: e.start)],
            "findings": related, "routing": {r.title.strip(): m.route(r) for r in rules},
            "investigate": [{"rule": r.title.strip(), "key": r.key,
                             "guide": guide_for(m, r, next((e.labels for e in i["_eps"] if e.uid == r.uid), {}), i["start"], i["end"])}
                            for r in rules],
            "rules_detail": [{**rule_row(m, r), "queries": m.queries(r), "annotations": {k: v for k, v in r.annotations.items() if not k.startswith("__") and k != "dashboard_url"}} for r in rules]}


def incidents_list(m: Model) -> dict:
    return {"fetched_at": m.fetched_at, "gap_min": config.INCIDENT_GAP_MIN, "items": [inc_row(i) for i in m.incidents]}


def toil(m: Model) -> dict:
    inc = m.incidents
    weeks: dict[str, dict] = {}
    for i in inc:
        t = local(i["start"])
        wk = (t - timedelta(days=t.weekday())).date().isoformat()
        w = weeks.setdefault(wk, {"week": wk, "incidents": 0, "critical": 0, "offhours": 0, "night": 0, "preventable": 0, "minutes": 0.0})
        w["incidents"] += 1
        w["critical"] += i["severity"] == "critical"
        w["offhours"] += i["offhours"]
        w["night"] += i["night"]
        w["preventable"] += i["preventable"]
        w["minutes"] += i["minutes"]
    heat = [[0] * 24 for _ in range(7)]
    for i in inc:
        t = local(i["start"])
        heat[t.weekday()][t.hour] += 1
    # Google SRE: 12 saatlik nöbet vardiyasında en fazla 2 olay sürdürülebilir kabul edilir.
    shifts: Counter = Counter()
    for i in inc:
        t = local(i["start"])
        day_shift = 8 <= t.hour < 20
        anchor = t.date() if (day_shift or t.hour >= 20) else (t - timedelta(days=1)).date()
        shifts[(anchor.isoformat(), "gündüz" if day_shift else "gece")] += 1
    n_shifts = config.WINDOW_DAYS * 2
    over = {k: v for k, v in shifts.items() if v > 2}
    sources = Counter()
    for i in inc:
        for r in i["rules"]:
            sources[(r["key"], r["title"])] += 1
    return {
        "fetched_at": m.fetched_at,
        "totals": {
            "incidents": len(inc), "critical": sum(i["severity"] == "critical" for i in inc),
            "offhours": sum(i["offhours"] for i in inc), "night": sum(i["night"] for i in inc),
            "preventable": sum(i["preventable"] for i in inc),
            "shifts": n_shifts, "shifts_over": len(over), "max_shift": max(shifts.values(), default=0),
            "per_day": round(len(inc) / config.WINDOW_DAYS, 1),
        },
        "weeks": sorted(weeks.values(), key=lambda w: w["week"]),
        "heat": heat,
        "worst_shifts": [{"day": k[0], "shift": k[1], "incidents": v} for k, v in sorted(over.items(), key=lambda kv: -kv[1])[:10]],
        "sources": [{"key": k[0], "title": k[1].strip(), "incidents": v} for k, v in sources.most_common(10)],
    }
