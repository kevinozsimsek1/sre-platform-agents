"""Basit TTL önbellek: aynı anahtar için eşzamanlı istekler tek hesaplamayı bekler."""
import asyncio
import time
from typing import Any, Awaitable, Callable

_store: dict[str, tuple[float, Any]] = {}
_locks: dict[str, asyncio.Lock] = {}


async def cached(key: str, ttl: int, fn: Callable[[], Awaitable[Any]], force: bool = False) -> Any:
    hit = _store.get(key)
    if hit and not force and time.time() - hit[0] < ttl:
        return hit[1]
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _store.get(key)
        if hit and not force and time.time() - hit[0] < ttl:
            return hit[1]
        value = await fn()
        _store[key] = (time.time(), value)
        return value


def cached_at(key: str) -> float | None:
    hit = _store.get(key)
    return hit[0] if hit else None


def invalidate(prefix: str) -> None:
    for k in [k for k in _store if k.startswith(prefix)]:
        _store.pop(k, None)
