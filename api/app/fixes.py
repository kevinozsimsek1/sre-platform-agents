"""Bulguları uygulanabilir değişikliğe çevirir: hangi alan, neden, ne olacak.

Portal Grafana'ya yazmaz. Burada üretilen şey insanın gözden geçirip uygulayacağı somut bir
değişiklik listesi ve kuralın düzeltilmiş tanımı. Sadece mekanik olarak türetilebilen değişiklikler
üretilir; sorgunun kendisini düzeltmek gibi yargı gerektiren şeyler öneri metni olarak kalır.
"""
from __future__ import annotations

import copy
import re
from typing import Any

from .analysis import Model, RuleModel, parse_dur

# "exceeds 0.5 seconds", ">0.5s", "0.5 saniyeyi aşınca" gibi ifadelerden yazarın niyet ettiği eşik
INTENT_RE = re.compile(
    r"(?:exceeds|above|over|greater than|higher than|>=?|aşınca|aşarsa|üstünde|üzerinde|geçerse)\s*"
    r"([0-9]+(?:\.[0-9]+)?)",
    re.I,
)
# Grafana sunucusunun kendi tuttuğu alanlar: düzeltilmiş tanımda yer almasın
SERVER_FIELDS = ("id", "updated", "orgID")


def _threshold(raw: dict[str, Any]) -> tuple[int, float, str] | None:
    """Eşik ifadesinin yerini bulur: (data index, şu anki değer, karşılaştırma tipi)."""
    for i, d in enumerate(raw.get("data", [])):
        model = d.get("model") or {}
        if model.get("type") != "threshold":
            continue
        conds = model.get("conditions") or []
        if not conds:
            continue
        ev = conds[0].get("evaluator") or {}
        params = ev.get("params") or []
        if len(params) != 1 or not isinstance(params[0], (int, float)):
            continue
        return i, float(params[0]), str(ev.get("type", "gt"))
    return None


def _intended(r: RuleModel, current: float) -> float | None:
    """Kuralın kendi açıklamasında yazan eşik, şu ankinden farklıysa onu döndürür."""
    for key in ("summary", "description"):
        text = r.annotations.get(key) or ""
        for m in INTENT_RE.finditer(text):
            try:
                v = float(m.group(1))
            except ValueError:
                continue
            if v > 0 and abs(v - current) > 1e-9:
                return v
    return None


def _for_target(r: RuleModel) -> int:
    cur = parse_dur(r.for_)
    return int(5.0 if cur < 5 else cur * 2)


def _title_severity(title: str) -> str | None:
    t = title.lower()
    if "critical" in t:
        return "critical"
    if "warning" in t or "warn" in t:
        return "warning"
    return None


def plan(m: Model, r: RuleModel) -> dict[str, Any] | None:
    """Kuralın bulgularından uygulanabilir değişiklikler. Yoksa None."""
    codes = {f["code"] for f in r.findings}
    fixed = copy.deepcopy(r.raw)
    for k in SERVER_FIELDS:
        fixed.pop(k, None)
    changes: list[dict[str, Any]] = []
    manual: list[dict[str, str]] = []

    # --- Dalgalı: bekleme süresini uzat
    if "flapping" in codes:
        target = _for_target(r)
        f = next(x for x in r.findings if x["code"] == "flapping")
        changes.append({
            "field": "for", "label": "Bekleme süresi (for)", "from": r.for_, "to": f"{target}m", "code": "flapping",
            "why": f"Tetiklenmelerin çoğu kendiliğinden kısa sürede düzeliyor. {target} dakika beklemek, "
                   f"geçmiş veriye göre yaklaşık {f['impact'].get('fires', 0)} tetiklenmeyi önler.",
        })
        fixed["for"] = f"{target}m"

    # --- Kopya: Warning ile Critical aynı eşikte
    if "duplicate" in codes:
        th = _threshold(r.raw)
        twins = [o for o in m.rules.values() if o is not r and o.signature == r.signature]
        other = ", ".join(o.title for o in twins)
        if th:
            idx, current, op = th
            want = _intended(r, current)
            if want is None and r.severity == "warning":
                want = round(current / 2, 4)  # alt seviye kuralı daha erken uyarsın
            if want is not None:
                src = "Kuralın kendi açıklamasında bu eşik yazıyor" if _intended(r, current) is not None \
                    else "Warning, Critical'dan önce uyarmalı"
                changes.append({
                    "field": "threshold", "label": f"Eşik ({op})", "from": current, "to": want, "code": "duplicate",
                    "why": f"{src}; şu an {other} ile birebir aynı eşikte olduğu için her olayda ikisi birlikte geliyor.",
                })
                fixed["data"][idx]["model"]["conditions"][0]["evaluator"]["params"] = [want]
            else:
                manual.append({"code": "duplicate", "what": f"Eşiği {other} kuralından ayırın ya da kopyayı silin."})
        else:
            manual.append({"code": "duplicate", "what": f"{other} ile aynı sorguyu kullanıyor; birini silin."})

    # --- Ad ile seviye uyuşmuyor
    if "severity" in codes:
        want = _title_severity(r.title)
        if want and want != r.severity:
            changes.append({
                "field": "labels.severity", "label": "severity etiketi", "from": r.severity, "to": want, "code": "severity",
                "why": f"Kuralın adı '{r.title}' ama etiketi '{r.severity}'. Alert beklenen kanala gitmiyor.",
            })
            fixed.setdefault("labels", {})["severity"] = want

    # --- Yargı gerektirenler: sadece ne yapılacağını söyle.
    # Duraklatılmış kuralı kendiliğinden "aç" diye önermiyoruz: neden duraklatıldığını bilmiyoruz,
    # doğru karar açmak kadar silmek de olabilir.
    if "paused" in codes:
        manual.append({"code": "paused", "what": "Sorgusu hatalı olduğu için duraklatılmış olabilir: önce sebebine bakın, sonra ya açın ya silin."
                       if "broken" in codes else
                       "Kural değerlendirilmiyor; izlendiği sanılan alan aslında izlenmiyor. Hâlâ gerekli mi diye karar verip ya açın ya silin."})

    for code, what in (
        ("broken", "Sorgu sürekli hata veriyor. Veri kaynağını ve sorguyu düzeltmek gerekiyor; bu mekanik olarak türetilemez."),
        ("nodata", "Sorgu sık sık boş dönüyor. Metrik adı, etiketler ve zaman aralığı kontrol edilmeli."),
        ("scheduled", "Her gün aynı saatte tetikleniyor. Beklenen bir işse o saat için mute timing tanımlanmalı."),
        ("long_open", "Uzun süredir açık seriler var. Ya sorun kapatılmalı ya da bu kuralın gerekliliğine karar verilmeli."),
        ("offhours", "Çoğunlukla mesai dışında tetikleniyor. Gece müdahale gerekmiyorsa seviyesi düşürülmeli."),
        ("copy", "Adında '(copy)' var. Gerekliyse anlamlı bir ad verilmeli, değilse silinmeli."),
    ):
        if code in codes:
            manual.append({"code": code, "what": what})

    if not changes and not manual:
        return None
    return {
        "changes": changes,
        "manual": manual,
        "rule": fixed if changes else None,
        "uid": r.uid,
        "org": r.org,
    }
