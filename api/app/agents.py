"""Olayı agent'a inceletme. Agent'lar dev hesabında çalıştığı için prod'u doğrudan göremeyebilir;
bu yüzden olayın bütün bağlamı (kural, sorgu, eşik, seriler, zaman aralığı) prompt'la birlikte gönderilir."""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

import httpx

from . import config
from .analysis import local

_lock = asyncio.Lock()
_running: dict[str, dict] = {}
_path = os.path.join(config.DATA_DIR, "analyses.json")


def _load() -> dict[str, list[dict]]:
    try:
        with open(_path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(data: dict) -> None:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    tmp = _path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, _path)


def registry() -> list[dict]:
    return [{"id": k, "label": v.get("label", k), "description": v.get("description", "")} for k, v in config.AGENT_REGISTRY.items()]


def recommend(signals: list[str]) -> dict[str, Any]:
    """Kuralın veri kaynağı tipleri, sorguları ve etiketlerinden en uygun agent'ı seçer."""
    text = " ".join(signals).lower()
    scores = []
    for aid, meta in config.AGENT_REGISTRY.items():
        hits = [h for h in meta.get("handles", []) if h.lower() in text]
        scores.append((len(hits), aid, hits))
    scores.sort(key=lambda x: -x[0])
    n, aid, hits = scores[0] if scores else (0, config.DEFAULT_AGENT, [])
    if n == 0:
        aid = config.DEFAULT_AGENT
        return {"agent": aid, "reason": "Belirgin bir eşleşme yok; varsayılan agent önerildi."}
    label = config.AGENT_REGISTRY[aid].get("label", aid)
    return {"agent": aid, "reason": f"{label} önerildi: alert'te {', '.join(sorted(set(hits))[:4])} sinyalleri var."}


def for_target(key: str) -> dict[str, Any]:
    return {"items": _load().get(key, []), "running": _running.get(key)}


def for_incident(iid: str) -> dict[str, Any]:
    return for_target(f"incident:{iid}")


def count() -> int:
    return sum(len(v) for v in _load().values())


OUTPUT = [
    "",
    "İstenen çıktı (Türkçe, kısa ve somut):",
    "1. Olası kök neden (kanıtınla birlikte; erişebildiğin log/metrikleri kullan).",
    "2. Etki: hangi servis/kullanıcı etkilenmiş olabilir.",
    "3. Bu gerçek bir sorun mu, yoksa gürültü mü? Gerekçesiyle.",
    "4. Önerilen adımlar (önce yapılacak olan en üstte).",
    "Erişemediğin veriler varsa bunu açıkça belirt; tahmin yürütme.",
]


def rule_prompt(d: dict, episode: dict | None) -> str:
    r = d["rule"]
    lines = ["Bir Grafana alert kuralını incelemeni istiyorum. Ortam: prod.",
             f"Kural: {r['title']} (severity={r['severity']}, for={r['for']}, klasör={r['folder']}, şu anki durum={r['state']})"]
    for q in d["queries"]:
        lines.append(f"  [{q['ref']}] {q['kind']}: {q.get('text', '')}")
    if r["annotations"].get("description"):
        lines.append(f"  açıklama: {r['annotations']['description']}")
    lines.append(f"Son {len(d['daily'])} gün: {r['fires']} tetiklenme, {r['errors']} sorgu hatası, ortanca süre {r['median']} dk.")
    if episode:
        end = f"{local(episode['end']):%d.%m %H:%M}" if episode.get("end") else "hâlâ açık"
        lines.append(f"Özellikle şu tetiklenmeye odaklan: {episode['series']} · {local(episode['start']):%d.%m.%Y %H:%M} → {end} · değer: {episode.get('value')}")
    if d["findings"]:
        lines += ["Portalın bulguları:"] + [f"- {f['title']}: {f['detail']}" for f in d["findings"]]
    if d["errors"]:
        lines += ["En sık sorgu hataları:"] + [f"- ({e['count']}x) {e['message']}" for e in d["errors"][:3]]
    return "\n".join(lines + OUTPUT)


def slo_prompt(d: dict) -> str:
    s = d["service"] or {}
    t, m = s.get("target", {}), s.get("measured") or {}
    lines = [f"Prod'daki {s.get('service')} servisinin hedef (SLO) durumunu incelemeni istiyorum.",
             f"Hedef: isteklerin %{t.get('latency_target', 0)*100:.0f}'i {t.get('latency_ms')} ms altında, erişilebilirlik %{t.get('availability', 0)*100:.2f} "
             f"(kaynak: {t.get('source')}).",
             f"Son {d['window_days']} gün: {m.get('requests')} istek, {m.get('errors_5xx')} adet 5xx, {m.get('slow')} yavaş istek. {s.get('explain') or ''}",
             "En sorunlu route'lar (route · istek · 5xx · yavaş · p95 sn):"]
    lines += [f"- {r['route']} · {r['requests']} · {r['errors_5xx']} · {r['slow']} · {r['p95_s']}" for r in d["routes"][:10]]
    return "\n".join(lines + OUTPUT)


def build_prompt(inc: dict) -> str:
    lines = [
        "Bir SRE olayını incelemeni istiyorum. Aşağıda Grafana'dan gelen alert'lerin tam bağlamı var.",
        f"Olay: {inc['id']} · başlangıç {local(inc['start']):%d.%m.%Y %H:%M} (İstanbul) · süre {inc['minutes']} dk"
        + (" · HÂLÂ AÇIK" if inc["ongoing"] else ""),
        "",
        "Tetiklenen kurallar:",
    ]
    for r in inc["rules_detail"]:
        lines.append(f"- {r['title']} (severity={r['severity']}, for={r['for']}, klasör={r['folder']})")
        for q in r["queries"]:
            lines.append(f"    [{q['ref']}] {q['kind']}: {q.get('text', '')}")
        if r["annotations"].get("description"):
            lines.append(f"    açıklama: {r['annotations']['description']}")
    lines += ["", "Zaman çizelgesi (seri · başlangıç → bitiş · değer):"]
    for e in inc["timeline"][:40]:
        end = f"{local(e['end']):%H:%M}" if e["end"] else "açık"
        lines.append(f"- {e['rule']['title']} · {e['series']} · {local(e['start']):%H:%M} → {end} · {e['value']}")
    if inc.get("changes"):
        lines += ["", "Olaydan önceki 60 dakikada prod'da yapılan değişiklikler (deploy / yeniden başlatma):"]
        for b in inc["changes"][:5]:
            names = ", ".join(f"{i['namespace']}/{i['deployment']} ({'yeni sürüm ' + str(i['version']) if i['kind'] == 'release' else 'yeniden başlatma'})" for i in b["items"][:8])
            lines.append(f"- olaydan {b['minutes_before']} dk önce, {b['deployments']} deployment: {names}")
    if inc["findings"]:
        lines += ["", "Portalın bu kurallar hakkındaki bulguları:"]
        lines += [f"- {f['rule']}: {f['title']}" for f in inc["findings"]]
    return "\n".join(lines + OUTPUT)


async def run(key: str, prompt: str, agent: str, by: dict | None = None, question: str | None = None) -> None:
    iid = key
    url = config.AGENTS[agent].rstrip("/") + "/chat"
    if question:
        prompt += "\n\nKullanıcının ek sorusu: " + question.strip()[:1000]
    _running[iid] = {"agent": agent, "started": int(time.time() * 1000)}
    started = time.time()
    result: dict[str, Any] = {"agent": agent, "started": int(started * 1000), "by": (by or {}).get("user") or (by or {}).get("visitor"),
                              "question": question}
    try:
        extra = config.AGENT_REGISTRY.get(agent, {}).get("payload", {})
        async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=5)) as c:
            r = await c.post(url, json={"message": prompt, **extra})
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"detail": r.text[:500]}
        if r.status_code >= 400:
            result.update(status="error", error=str(body.get("detail", body))[:600])
        else:
            text = body.get("response") or body.get("reply") or ""
            tools = body.get("tools_used") or [t.get("name", "?") for t in body.get("tool_calls", []) if isinstance(t, dict)]
            result.update(status="ok", text=text, tools=tools)
    except httpx.HTTPError as exc:
        result.update(status="error", error=f"Agent'a ulaşılamadı ({type(exc).__name__}). GPU node ve agent pod'u açık mı?")
    finally:
        result["seconds"] = round(time.time() - started, 1)
        _running.pop(iid, None)
        async with _lock:
            data = _load()
            data.setdefault(iid, []).insert(0, result)
            _save(data)
