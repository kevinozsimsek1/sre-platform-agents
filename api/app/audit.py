"""Denetim kaydı (audit log): portalda kim, ne zaman, nereden, ne yaptı.

Kayıtlar DATA_DIR/audit.jsonl dosyasına satır satır eklenir. Görüntüleme yalnızca admin oturumuyla.
Admin şifresi düz metin tutulmaz; ADMIN_PASSWORD_HASH (pbkdf2_sha256) ortam değişkeninden gelir.
Hash üretmek için:  python -m app.audit hash
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import sys
import time
from collections import Counter, defaultdict, deque
from typing import Any
from urllib.parse import unquote

from fastapi import Request

from . import config

log = logging.getLogger("portal.audit")
PATH = os.path.join(config.DATA_DIR, "audit.jsonl")
MAX_BYTES = 50 * 1024 * 1024
ADMIN_USER = os.getenv("ADMIN_USER", "root")
ADMIN_HASH = os.getenv("ADMIN_PASSWORD_HASH", "")
SESSION_HOURS = 8
_lock = asyncio.Lock()
_sessions: dict[str, float] = {}
_fails: dict[str, deque] = defaultdict(deque)

STATIC_EXT = (".js", ".css", ".png", ".svg", ".ico", ".woff", ".woff2", ".map", ".jpg", ".gif")


# ------------------------------------------------------------- şifre
def make_hash(password: str, iterations: int = 390_000) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def check_password(password: str) -> bool:
    try:
        algo, it, salt, digest = ADMIN_HASH.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt), int(it))
        return hmac.compare_digest(dk, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


# ------------------------------------------------------------- istek bilgisi
def client_ip(req: Request) -> str:
    # X-Real-IP'yi nginx kendisi koyar ($remote_addr); X-Forwarded-For istemci tarafından taklit edilebilir.
    return req.headers.get("x-real-ip") or (req.client.host if req.client else "?")


def who(req: Request) -> dict[str, Any]:
    return {
        "ip": client_ip(req),
        # Portal istekleri başlıkla, agent arayüzü istekleri (nginx mirror) çerezle gelir.
        "user": unquote(req.headers.get("x-portal-user") or req.cookies.get("portal_user") or "").strip()[:60] or None,
        "visitor": (req.headers.get("x-portal-visitor") or req.cookies.get("portal_visitor") or "").strip()[:40] or None,
        "ua": (req.headers.get("user-agent") or "")[:200],
    }


# ------------------------------------------------------------- yazma / okuma
async def write(event: dict[str, Any]) -> None:
    event.setdefault("ts", int(time.time() * 1000))
    line = json.dumps(event, ensure_ascii=False) + "\n"
    async with _lock:
        try:
            os.makedirs(config.DATA_DIR, exist_ok=True)
            if os.path.exists(PATH) and os.path.getsize(PATH) > MAX_BYTES:
                os.replace(PATH, PATH + ".1")
            with open(PATH, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError as exc:
            # Kayıt yazılamazsa portal çalışmaya devam etmeli; sorun pod loguna düşer.
            log.error("Denetim kaydı yazılamadı: %s", exc)


def read(limit: int = 500, q: str | None = None, kind: str | None = None, user: str | None = None, since: int | None = None) -> dict[str, Any]:
    rows: list[dict] = []
    for p in (PATH + ".1", PATH):
        try:
            with open(p, encoding="utf-8") as f:
                for line in f:
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except FileNotFoundError:
            pass
    total = len(rows)
    if since:
        rows = [r for r in rows if r.get("ts", 0) >= since]
    if kind:
        rows = [r for r in rows if r.get("kind") == kind]
    if user:
        rows = [r for r in rows if (r.get("user") or r.get("visitor") or "") == user]
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in json.dumps(r, ensure_ascii=False).lower()]
    day = int(time.time() * 1000) - 86_400_000
    recent = [r for r in rows if r.get("ts", 0) >= day]
    people = Counter(f"{str(r.get('visitor') or '—')[:8]} · {r.get('ip')}" for r in rows if r.get("kind") != "admin")
    return {
        "total": total, "matched": len(rows),
        "stats": {
            "events_24h": len(recent),
            "people_24h": len({(r.get("visitor") or r.get("ip")) for r in recent}),
            "ips": len({r.get("ip") for r in rows}),
            "failed_logins": sum(1 for r in rows if r.get("kind") == "admin" and r.get("action") == "login_failed"),
            "agent_questions": sum(1 for r in rows if r.get("kind") == "agent"),
        },
        "people": [{"name": k, "events": v} for k, v in people.most_common(20)],
        "events": list(reversed(rows))[:limit],
    }


# ------------------------------------------------------------- admin oturumu
def rate_limited(ip: str) -> bool:
    q = _fails[ip]
    now = time.time()
    while q and now - q[0] > 900:
        q.popleft()
    return len(q) >= 5


def login(username: str, password: str, ip: str) -> str | None:
    if not ADMIN_HASH:
        return None
    ok = hmac.compare_digest(username.encode(), ADMIN_USER.encode()) & check_password(password)
    if not ok:
        _fails[ip].append(time.time())
        return None
    token = secrets.token_urlsafe(32)
    _sessions[token] = time.time() + SESSION_HOURS * 3600
    return token


def valid(token: str | None) -> bool:
    if not token:
        return False
    exp = _sessions.get(token)
    if not exp or exp < time.time():
        _sessions.pop(token or "", None)
        return False
    return True


def logout(token: str | None) -> None:
    _sessions.pop(token or "", None)


if __name__ == "__main__" and sys.argv[1:] == ["hash"]:
    import getpass

    p1 = getpass.getpass("Yeni admin şifresi: ")
    p2 = getpass.getpass("Tekrar: ")
    if p1 != p2 or len(p1) < 12:
        sys.exit("Şifreler eşleşmiyor ya da 12 karakterden kısa.")
    print(make_hash(p1))
