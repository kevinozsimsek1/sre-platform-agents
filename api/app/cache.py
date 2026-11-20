"""Basit TTL önbellek: aynı anahtar için eşzamanlı istekler tek hesaplamayı bekler."""
import asyncio
import time
from typing import Any, Awaitable, Callable

_store: dict[str, tuple[float, Any]] = {}
_locks: dict[str, asyncio.Lock] = {}

FAIL_TTL = 60   # başarısız sonuç uzun süre saklanmaz: geçici kesinti sayfayı saatlerce boş bırakmasın


async def cached(
    key: str,
    ttl: int,
    fn: Callable[[], Awaitable[Any]],
    force: bool = False,
    ok: Callable[[Any], bool] | None = None,
) -> Any:
    """`ok` verilirse, başarısız sonuç önbelleğe uzun süre yazılmaz.

    AWS ya da Grafana bir kez cevap vermediğinde toplayıcılar hata fırlatmaz; "available: False"
    döner. Bu sonuç normal TTL ile saklansa, saniyeler sonra düzelen bir kesinti sayfayı
    TTL boyunca (örn. 6 saat) boş gösterirdi. Bu yüzden:
      - elde eski ve geçerli bir sonuç varsa o korunur, başarısız sonuç üzerine yazmaz;
      - yoksa başarısız sonuç yalnızca FAIL_TTL kadar saklanır, sonraki istek yeniden dener.
    """
    hit = _store.get(key)
    if hit and not force:
        age = time.time() - hit[0]
        good = ok is None or ok(hit[1])
        if age < (ttl if good else FAIL_TTL):
            return hit[1]
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _store.get(key)
        if hit and not force:
            age = time.time() - hit[0]
            good = ok is None or ok(hit[1])
            if age < (ttl if good else FAIL_TTL):
                return hit[1]
        value = await fn()
        if ok is not None and not ok(value) and hit and ok(hit[1]):
            return hit[1]            # eski geçerli veri duruyor; kesintide onu göster
        _store[key] = (time.time(), value)
        return value


def available(value: Any) -> bool:
    """Toplayıcıların ortak sözleşmesi: dict ve "available" alanı varsa o belirler."""
    return not (isinstance(value, dict) and value.get("available") is False)


def cached_at(key: str) -> float | None:
    hit = _store.get(key)
    return hit[0] if hit else None


def invalidate(prefix: str) -> None:
    for k in [k for k in _store if k.startswith(prefix)]:
        _store.pop(k, None)
