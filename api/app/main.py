"""Nebim SRE Portal API. Tüm uçlar /_portal/api altında; nginx aynı pod'dan buraya yönlendirir."""
from __future__ import annotations

import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Cookie, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import agents, analysis, audit, changes, config, gpu, slo
from .cache import cached
from .grafana import GrafanaError

log = logging.getLogger("portal")


async def _keep_warm() -> None:
    """Veriyi arka planda hazır tutar: kullanıcı sayfayı açtığında Grafana'yı beklemez.
    Önbellek süresi dolmadan yenilendiği için istekler hep hazır veriyi görür."""
    while True:
        jobs = (("alert verisi", lambda: model(True)), ("SLO", lambda: slo_overview(True)),
                ("değişiklikler", lambda: changes_data(True)), ("GPU", lambda: cached("gpu", 300, gpu.overview, True)))
        for name, job in jobs:
            try:
                await job()
            except Exception as exc:  # bir kaynak hata verse de diğerleri yenilensin
                log.warning("Arka plan yenileme başarısız (%s): %s", name, exc)
        await asyncio.sleep(max(60, config.CACHE_TTL - 60))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(_keep_warm())
    yield
    task.cancel()


app = FastAPI(title="Nebim SRE Portal API", docs_url="/_portal/api/docs", openapi_url="/_portal/api/openapi.json", lifespan=lifespan)
api = APIRouter(prefix="/_portal/api")
COOKIE = "portal_admin"

# Denetim kaydına yazılmayan, çok sık çağrılan ya da kendisi kayıt olan uçlar
SKIP_AUDIT = ("/_portal/api/health", "/_portal/api/audit/", "/_portal/api/admin/audit")


@app.middleware("http")
async def audit_requests(request: Request, call_next):
    t0 = time.time()
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/_portal/api") and not path.startswith(SKIP_AUDIT):
        await audit.write({
            "kind": "api", "action": f"{request.method} {path}", "query": str(request.url.query)[:300] or None,
            "status": response.status_code, "ms": int((time.time() - t0) * 1000), **audit.who(request),
        })
    return response


# ------------------------------------------------------------- veri
async def model(force: bool = False) -> analysis.Model:
    async def build() -> analysis.Model:
        raw = await analysis.fetch_raw()
        return await asyncio.to_thread(analysis.Model, raw)
    try:
        return await cached("model", config.CACHE_TTL, build, force)
    except GrafanaError as exc:
        raise HTTPException(502, f"Grafana'dan veri alınamadı: {exc}") from exc


async def slo_overview(force: bool = False) -> dict:
    try:
        return await cached("slo", 600, slo.overview, force)
    except GrafanaError as exc:
        raise HTTPException(502, f"Prometheus'tan veri alınamadı: {exc}") from exc


async def slo_detail(service: str) -> dict:
    try:
        return await cached(f"slo:{service}", 600, lambda: slo.service_detail(service))
    except GrafanaError as exc:
        raise HTTPException(502, f"Prometheus'tan veri alınamadı: {exc}") from exc


async def changes_data(force: bool = False) -> dict:
    try:
        return await cached("changes", config.CACHE_TTL, changes.collect, force)
    except GrafanaError as exc:
        raise HTTPException(502, f"Değişiklik verisi alınamadı: {exc}") from exc


async def changes_or_empty() -> dict:
    try:
        return await changes_data()
    except HTTPException:
        return {"batches": []}


def _inc_changes(ch: dict, i: dict) -> list[dict]:
    labels = [e.labels for e in i["_eps"]]
    return changes.for_incident(ch, i["start"], labels, [r["title"] for r in i["rules"]])


@api.get("/health")
async def health() -> dict:
    return {"ok": True}


@api.get("/config")
async def public_config() -> dict:
    """Arayüzün ihtiyaç duyduğu, gizli olmayan ayarlar."""
    return {"aws_account": config.AWS_PROD_ACCOUNT or None, "grafana_url": config.GRAFANA_URL}


@api.get("/overview")
async def overview(refresh: bool = False) -> dict:
    m, g = await asyncio.gather(model(refresh), cached("gpu", 300, gpu.overview, refresh))
    try:
        s = await slo_overview(refresh)
    except HTTPException:
        s = {"services": []}  # SLO alınamazsa genel bakış yine açılsın
    summ = analysis.summary(m)
    day_ago = int(time.time() * 1000) - 86_400_000
    # Watchdog / DeadMansSwitch tasarım gereği hep alarmdadır; "şu an alarmda" listesine alınmaz.
    firing = [analysis.rule_row(m, r) for r in m.rules.values()
              if r.state == "firing" and not re.search(r"watchdog|deadmansswitch", r.title + str(r.labels), re.I)]
    return {
        "fetched_at": m.fetched_at,
        "alerts": {**summ["totals"], "top_findings": summ["findings"][:5]},
        "firing": sorted(firing, key=lambda r: (r["severity"] != "critical", r["title"])),
        "incidents_24h": [analysis.inc_row(i) for i in m.incidents if i["start"] >= day_ago][:20],
        "slo": {k: sum(1 for x in s["services"] if x["status"] == k) for k in ("breached", "at_risk", "ok", "low_traffic")},
        "slo_attention": [x for x in s["services"] if x["status"] in ("breached", "at_risk")][:6],
        "gpu": {k: g.get(k) for k in ("available", "running", "hours", "cost_usd", "failed_launches", "reason")},
    }


@api.get("/alerts/summary")
async def alerts_summary(refresh: bool = False) -> dict:
    return analysis.summary(await model(refresh))


@api.get("/alerts/rules/{org}/{uid}")
async def rule(org: int, uid: str) -> dict:
    d = analysis.rule_detail(await model(), f"{org}:{uid}")
    if not d:
        raise HTTPException(404, "Kural bulunamadı")
    r = (await model()).rules[f"{org}:{uid}"]
    return {**d, "analysis": agents.for_target(f"rule:{org}:{uid}"), "agents": agents.registry(),
            "agent_suggestion": agents.recommend(analysis.signals(await model(), r))}


@api.get("/alerts/rules/{org}/{uid}/investigate")
async def rule_investigate(org: int, uid: str, start: int, end: int | None = None, series: str | None = None) -> dict:
    """Tek bir tetiklenme için inceleme rehberi (zaman aralığı ve seri o tetiklenmeye göre)."""
    m = await model()
    r = m.rules.get(f"{org}:{uid}")
    if not r:
        raise HTTPException(404, "Kural bulunamadı")
    ep = next((e for e in r.episodes + r.errors if e.start == start and (series is None or e.series == series)), None)
    return {"guide": analysis.guide_for(m, r, ep.labels if ep else None, start, end if end else (ep.end if ep else None))}


@api.get("/incidents")
async def incidents(refresh: bool = False) -> dict:
    m = await model(refresh)
    ch = await changes_or_empty()
    out = analysis.incidents_list(m)
    store = agents._load()
    by_id = {i["id"]: i for i in m.incidents}
    for i in out["items"]:
        i["analyses"] = len(store.get(f"incident:{i['id']}", []))
        found = _inc_changes(ch, by_id[i["id"]])
        i["after_change"] = bool(found)
        i["after_related_change"] = any(c["related"] for c in found)
    return out


@api.get("/incidents/{iid}")
async def incident(iid: str) -> dict:
    d = analysis.incident_detail(await model(), iid)
    if not d:
        raise HTTPException(404, "Olay bulunamadı (son 30 günün dışında kalmış olabilir)")
    m = await model()
    sig = [x for k in d["rules"] for x in analysis.signals(m, m.rules[k["key"]])]
    inc = next(i for i in m.incidents if i["id"] == iid)
    return {**d, "analysis": agents.for_incident(iid), "agents": agents.registry(), "agent_suggestion": agents.recommend(sig),
            "changes": _inc_changes(await changes_or_empty(), inc)}


@api.get("/changes")
async def changes_list(refresh: bool = False) -> dict:
    m, ch = await asyncio.gather(model(), changes_data(refresh))
    after = changes.incidents_after(ch, m.incidents)
    inc_by_id = {i["id"]: analysis.inc_row(i) for i in m.incidents}
    batches = [{**b, "incidents_after": [inc_by_id[x] for x in after.get(b["id"], []) if x in inc_by_id][:10]} for b in ch["batches"]]
    with_change = sum(1 for i in m.incidents if _inc_changes(ch, i))
    oldest = min((b["start"] for b in ch["batches"]), default=None)
    covered = [i for i in m.incidents if oldest and i["start"] >= oldest]
    return {**ch, "batches": batches,
            "correlation": {"incidents": len(covered), "after_change": sum(1 for i in covered if _inc_changes(ch, i)), "since": oldest,
                            "all_after_change": with_change}}


@api.get("/slo")
async def slo_list(refresh: bool = False) -> dict:
    return await slo_overview(refresh)


@api.get("/slo/{service}")
async def slo_service(service: str) -> dict:
    return {**await slo_detail(service), "analysis": agents.for_target(f"slo:{service}"), "agents": agents.registry(),
            "agent_suggestion": agents.recommend(["prometheus", "http_server", service])}


@api.get("/value")
async def value(refresh: bool = False) -> dict:
    m, g = await asyncio.gather(model(refresh), cached("gpu", 300, gpu.overview, refresh))
    return {"toil": analysis.toil(m), "gpu": g, "analyses": agents.count()}


# ------------------------------------------------------------- agent ile araştır
class InvestigateReq(BaseModel):
    kind: Literal["incident", "rule", "slo"]
    ref: str = Field(..., max_length=300)  # incident id | "org:uid" | servis adı
    agent: str = "auto"
    question: str | None = Field(None, max_length=1000)
    episode_start: int | None = None  # kural için: belirli bir tetiklenmeye odaklan
    episode_series: str | None = None


@api.post("/investigations", status_code=202)
async def investigate(req: InvestigateReq, request: Request, bg: BackgroundTasks) -> dict:
    if req.agent != "auto" and req.agent not in config.AGENTS:
        raise HTTPException(400, f"Bilinmeyen agent: {req.agent}")
    key = f"{req.kind}:{req.ref}"
    if agents.for_target(key)["running"]:
        raise HTTPException(409, "Bu konu için bir araştırma zaten sürüyor")
    m = await model()
    if req.kind == "incident":
        d = analysis.incident_detail(m, req.ref)
        if d:
            inc = next(i for i in m.incidents if i["id"] == req.ref)
            d["changes"] = _inc_changes(await changes_or_empty(), inc)
        prompt = agents.build_prompt(d) if d else None
    elif req.kind == "rule":
        d = analysis.rule_detail(m, req.ref)
        ep = None
        if d and req.episode_start:
            ep = next((e for e in d["episodes"] if e["start"] == req.episode_start and (not req.episode_series or e["series"] == req.episode_series)), None)
        prompt = agents.rule_prompt(d, ep) if d else None
    else:
        prompt = agents.slo_prompt(await slo_detail(req.ref))
    if not prompt:
        raise HTTPException(404, "Araştırılacak kayıt bulunamadı")
    if req.agent == "auto":
        if req.kind == "rule":
            req.agent = agents.recommend(analysis.signals(m, m.rules[req.ref]))["agent"]
        elif req.kind == "incident":
            req.agent = agents.recommend([x for k in d["rules"] for x in analysis.signals(m, m.rules[k["key"]])])["agent"]
        else:
            req.agent = config.DEFAULT_AGENT
    by = audit.who(request)
    await audit.write({"kind": "agent", "action": "investigate", "target": key, "agent": req.agent, "question": req.question, **by})
    bg.add_task(agents.run, key, prompt, req.agent, by, req.question)
    return {"started": True, "key": key}


@api.get("/investigations/{kind}/{ref:path}")
async def investigation(kind: str, ref: str) -> dict:
    return agents.for_target(f"{kind}:{ref}")


# ------------------------------------------------------------- denetim kaydı
class ClientEvent(BaseModel):
    type: Literal["page_view", "click", "action"]
    page: str = Field("", max_length=200)
    target: str = Field("", max_length=200)
    detail: str | None = Field(None, max_length=500)


class ClientBatch(BaseModel):
    events: list[ClientEvent] = Field(..., max_length=50)


@api.post("/audit/events", status_code=204)
async def client_events(batch: ClientBatch, request: Request) -> Response:
    who = audit.who(request)
    for e in batch.events:
        await audit.write({"kind": e.type, "action": e.target or e.page, "page": e.page, "detail": e.detail, **who})
    return Response(status_code=204)


@api.post("/audit/mirror", include_in_schema=False)
async def agent_mirror(request: Request) -> Response:
    """nginx, agent arayüzlerine giden isteklerin kopyasını buraya yollar (mirror). Dışarıdan erişim nginx'te kapalı."""
    uri = request.headers.get("x-original-uri", "")
    method = request.headers.get("x-original-method", "")
    path = uri.split("?")[0]
    if path.endswith(audit.STATIC_EXT) or path.rstrip("/").endswith(("/ready", "/health", "/healthz")):
        return Response(status_code=204)
    body = (await request.body())[:4000]
    message = None
    if body:
        try:
            import json
            message = (json.loads(body).get("message") or "")[:500] or None
        except (ValueError, AttributeError):
            message = None
    agent = request.headers.get("x-agent") or ("cloudwatch" if uri.startswith("/cloudwatch") else "eks" if uri.startswith("/eks") else None)
    await audit.write({"kind": "agent" if message else "agent_ui", "action": f"{method} {uri}"[:300], "agent": agent,
                       "question": message, **audit.who(request)})
    return Response(status_code=204)


# ------------------------------------------------------------- admin
class LoginReq(BaseModel):
    username: str = Field(..., max_length=60)
    password: str = Field(..., max_length=200)


@api.post("/admin/login")
async def admin_login(req: LoginReq, request: Request, response: Response) -> dict:
    who = audit.who(request)
    if not audit.ADMIN_HASH:
        raise HTTPException(503, "Admin şifresi tanımlı değil (ADMIN_PASSWORD_HASH).")
    if audit.rate_limited(who["ip"]):
        await audit.write({"kind": "admin", "action": "login_blocked", "detail": req.username, **who})
        raise HTTPException(429, "Çok fazla hatalı deneme. 15 dakika sonra tekrar dene.")
    token = audit.login(req.username, req.password, who["ip"])
    await audit.write({"kind": "admin", "action": "login_ok" if token else "login_failed", "detail": req.username, **who})
    if not token:
        raise HTTPException(401, "Kullanıcı adı ya da şifre yanlış.")
    secure = request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE, token, httponly=True, samesite="strict", secure=secure, path="/_portal/api", max_age=audit.SESSION_HOURS * 3600)
    return {"ok": True, "user": audit.ADMIN_USER}


@api.post("/admin/logout")
async def admin_logout(response: Response, portal_admin: str | None = Cookie(None)) -> dict:
    audit.logout(portal_admin)
    response.delete_cookie(COOKIE, path="/_portal/api")
    return {"ok": True}


@api.get("/admin/me")
async def admin_me(portal_admin: str | None = Cookie(None)) -> dict:
    return {"admin": audit.valid(portal_admin), "configured": bool(audit.ADMIN_HASH), "user": audit.ADMIN_USER}


@api.get("/admin/audit")
async def admin_audit(limit: int = 500, q: str | None = None, kind: str | None = None, user: str | None = None,
                      hours: int | None = None, portal_admin: str | None = Cookie(None)) -> dict:
    if not audit.valid(portal_admin):
        raise HTTPException(401, "Admin oturumu gerekli.")
    since = int(time.time() * 1000) - hours * 3_600_000 if hours else None
    return audit.read(min(limit, 2000), q, kind, user, since)


app.include_router(api)
