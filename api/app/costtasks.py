"""Maliyet bulgularını atanabilir görevlere çevirir.

Her görev şunu söyler: ne yapılacak, neden, kaç dolar kazandırır, nerede.
Görev kimliği bulgudan türediği için sabittir: analiz yenilenince atama kaybolmaz.
Atama ve "tamamlandı" durumu, olay atamalarıyla aynı kalıcı kayıtta tutulur.
"""
from __future__ import annotations

import time
from typing import Any

from . import config, store

DOC = "cost-tasks"
KEEP_DAYS = 180
TARGET_REFRESH_S = 60       # hızlı yenilenen dashboard'lar için önerilen süre
MIN_USD = 0.25              # bu tutarın altında kalan iyileştirme için görev açılmaz


def _scan_weight(r: dict) -> float:
    """Logs Insights kuralının tarama hacmine katkısı: pencere × log grubu × aylık tarama."""
    return sum(l["window_min"] * max(len(l["groups"]), 1) for l in r["logs"]) * r["evals_month"]


def build(cost: dict[str, Any]) -> list[dict[str, Any]]:
    """Sorgu maliyeti analizinden görev listesi üretir (saf fonksiyon)."""
    tasks: list[dict[str, Any]] = []
    bill = cost.get("bill") or {}
    scanned_cost = float((bill.get("scanned") or {}).get("cost") or 0) if bill.get("available") else 0.0
    log_rules = cost.get("log_rules") or []
    total_scan = sum(_scan_weight(r) for r in log_rules) or 1.0

    # 1) Logs Insights: pencere, değerlendirme aralığından uzun → aynı loglar yeniden taranıyor
    for r in log_rules:
        worst = max((l["overlap"] or 0 for l in r["logs"]), default=0)
        if worst < 3:
            continue
        win = max(l["window_min"] for l in r["logs"])
        groups = max(len(l["groups"]) for l in r["logs"])
        share = _scan_weight(r) / total_scan
        now_usd = round(scanned_cost * share, 2)
        saving = round(now_usd * (1 - 1 / worst), 2) if worst else 0.0
        tasks.append({
            "id": f"logs-window:{r['org']}:{r['uid']}",
            "kind": "logs_window", "severity": "crit" if worst >= 10 else "warn",
            "title": f"«{r['title'].strip()}» kuralında aynı loglar {worst:g} kez yeniden taranıyor",
            "fix": f"Sorgu penceresini {win:g} dakikadan {r['every_s'] // 60 or 1} dakikaya indirin; "
                   f"pencere mutlaka {win:g} dakika kalacaksa değerlendirme aralığını {win:g} dakikaya çıkarın. "
                   f"İkisi eşitlendiğinde her log bir kez taranır.",
            "why": f"Kural her {r['every_s']} saniyede {win:g} dakikalık veriyi {groups} log grubunda yeniden tarıyor; "
                   f"ayda {r['evals_month']:,} tarama yapıyor.".replace(",", "."),
            "saving_usd": saving, "current_usd": now_usd, "saving_note": f"tarama hacmi {worst:g} kat azalır",
            "math": [
                f"tarama ağırlığı = pencere × log grubu × aylık tarama = {win:g} dk × {groups} × {r['evals_month']:,} = {_scan_weight(r):,.0f}".replace(",", "."),
                f"pay = Logs Insights fatura kalemi × (bu kuralın ağırlığı ÷ toplam ağırlık)",
                f"     = ${scanned_cost:,.2f} × ({_scan_weight(r):,.0f} ÷ {total_scan:,.0f}) = ${now_usd:,.2f}".replace(",", "."),
                f"kazanç = pay × (1 − 1 ÷ israf) = ${now_usd:,.2f} × (1 − 1 ÷ {worst:g}) = ${saving:,.2f}",
            ],
            "where": f"Grafana · alert kuralı · {r['group']}",
            "links": [{"label": "Kuralı aç", "url": f"{config.GRAFANA_URL}/alerting/grafana/{r['uid']}/view?orgId={r['org']}"}],
        })

    # 2) Aynı Logs sorgusunu çalıştıran kural çiftleri (Warning + Critical)
    pairs: dict[tuple, list[dict]] = {}
    for r in log_rules:
        key = (r["org"], tuple(sorted(g for l in r["logs"] for g in l["groups"])), tuple(l["window_min"] for l in r["logs"]))
        if key[1]:
            pairs.setdefault(key, []).append(r)
    for key, rs in pairs.items():
        if len(rs) < 2:
            continue
        extra = sum(_scan_weight(r) for r in rs[1:]) / total_scan
        tasks.append({
            "id": f"logs-dup:{key[0]}:{'|'.join(sorted(r['uid'] for r in rs))}",
            "kind": "logs_duplicate", "severity": "warn",
            "title": f"{len(rs)} kural birebir aynı log sorgusunu çalıştırıyor",
            "fix": "Tek kurala indirin ve seviyeleri eşikle ayırın (ör. aynı sorgu üzerinde Warning ve Critical için "
                   "farklı eşik). Böylece tarama bir kez yapılır.",
            "why": "Aynı pencere, aynı log grupları. Karşılaştırmak için ikisini de açıp hangisinin kalacağına karar verin: "
                   + ", ".join(f"«{r['title'].strip()}» (her {r['every_s']} sn)" for r in rs),
            "saving_usd": round(scanned_cost * extra, 2), "current_usd": round(scanned_cost * extra, 2),
            "saving_note": f"tarama {len(rs)} kattan 1 kata iner",
            "math": [
                f"fazladan ağırlık = {len(rs) - 1} kopya kuralın tarama ağırlığı = {sum(_scan_weight(x) for x in rs[1:]):,.0f}".replace(",", "."),
                f"kazanç = Logs Insights fatura kalemi × (fazladan ağırlık ÷ toplam ağırlık)",
                f"       = ${scanned_cost:,.2f} × ({sum(_scan_weight(x) for x in rs[1:]):,.0f} ÷ {total_scan:,.0f}) = ${scanned_cost * extra:,.2f}".replace(",", "."),
            ],
            "where": "Grafana · alert kuralları",
            "links": [{"label": r["title"].strip()[:38] or "Kural", "url": f"{config.GRAFANA_URL}/alerting/grafana/{r['uid']}/view?orgId={r['org']}"} for r in rs],
        })

    # 3) Hızlı yenilenen, CloudWatch sorgusu olan dashboard'lar
    for d in cost.get("dashboards") or []:
        cur = d.get("real_cost_month")
        if not d["every_s"] or d["every_s"] >= TARGET_REFRESH_S or not cur:
            continue
        saving = round(cur * (1 - d["every_s"] / TARGET_REFRESH_S), 2)
        if saving < MIN_USD:
            continue
        tasks.append({
            "id": f"dash-refresh:{d['org']}:{d['uid']}",
            "kind": "dashboard_refresh", "severity": "warn",
            "title": f"«{d['title']}» {d['refresh']} yenileniyor",
            "fix": f"Yenileme süresini {d['refresh']} → 1 dakika yapın ve dashboard'ı bu ayarla kaydedin "
                   "(kaydedilen ayar, dashboard'ı açan herkes için varsayılan olur).",
            "why": f"{d['cloudwatch_metric']} CloudWatch metrik sorgusu {d['every_s']} saniyede bir tekrar gidiyor. "
                   f"1 dakikaya çıkmak sorgu sayısını {TARGET_REFRESH_S // d['every_s']} kat azaltır.",
            "saving_usd": saving, "current_usd": round(cur, 2),
            "saving_note": f"sorgu {TARGET_REFRESH_S // d['every_s']} kat azalır",
            "math": [
                f"ölçülen yük = panellerin istediği metrik × (30 gün ÷ yenileme) = {d.get('metrics_per_refresh') or d['cloudwatch_metric']} × ({30 * 86400:,} sn ÷ {d['every_s']} sn) = {d.get('load_month', 0):,} metrik/ay".replace(",", "."),
                f"pay = metrik sorgusu fatura kalemi × (bu dashboard'ın yükü ÷ toplam yük) = ${cur:,.2f}",
                f"kazanç = pay × (1 − mevcut yenileme ÷ hedef yenileme)",
                f"       = ${cur:,.2f} × (1 − {d['every_s']} sn ÷ {TARGET_REFRESH_S} sn) = ${saving:,.2f}",
            ],
            "where": f"Grafana · dashboard{' · ' + d['folder'] if d['folder'] else ''}",
            "links": [{"label": "Yenileme ayarını aç", "url": d.get("settings_url") or d["url"]}],
        })

    # 4) Aynı adı taşıyan kopya dashboard'lar
    by_title: dict[str, list[dict]] = {}
    for d in cost.get("dashboards") or []:
        if d["cloudwatch_metric"] or d["cloudwatch_logs"]:
            by_title.setdefault(d["title"], []).append(d)
    for title, ds in by_title.items():
        if len(ds) < 2:
            continue
        ds = sorted(ds, key=lambda x: -(x.get("real_cost_month") or 0))
        saving = round(sum(x.get("real_cost_month") or 0 for x in ds[1:]), 2)
        tasks.append({
            "id": f"dash-dup:{title}",
            "kind": "dashboard_duplicate", "severity": "warn" if saving >= MIN_USD else "info",
            "title": f"«{title}» adında {len(ds)} dashboard var",
            "fix": "Hangisinin güncel olduğuna karar verip diğerlerini silin. Silmek istenmiyorsa en az "
                   "yenilemelerini kapatın; kapalı yenileme sorgu atmaz.",
            "why": "Hepsini açıp karşılaştırın; genelde en güncel olan kalır. Kopyalar: "
                   + ", ".join(
                       f"org {x['org']}{'/' + x['folder'] if x['folder'] else ''} — yenileme {x['refresh'] or 'kapalı'}"
                       + (f", ${x['real_cost_month']:.2f}/ay" if x.get("real_cost_month") else "")
                       for x in ds),
            "saving_usd": saving, "current_usd": round(sum(x.get("real_cost_month") or 0 for x in ds), 2),
            "saving_note": "kopya kadar sorgu ortadan kalkar",
            "math": [
                "şu an = kopyaların paylarının toplamı",
                "      = " + " + ".join(f"${x.get('real_cost_month') or 0:,.2f}" for x in ds)
                + f" = ${sum(x.get('real_cost_month') or 0 for x in ds):,.2f}",
                f"kazanç = şu an − en pahalı kopyanın payı (o kalacak)",
                f"       = ${sum(x.get('real_cost_month') or 0 for x in ds):,.2f} − ${ds[0].get('real_cost_month') or 0:,.2f} = ${saving:,.2f}",
            ],
            "where": "Grafana · dashboard",
            "links": [{"label": f"org {x['org']}{' / ' + x['folder'] if x['folder'] else ''}",
                       "url": x.get("settings_url") or x["url"]} for x in ds],
        })

    # 5) Boyutu olmayan / joker içeren sorgular: beklenenden çok metrik çekiyor.
    # Çok sayıda panelde görülebilen bir desen olduğu için yalnızca en pahalı birkaçı için görev açılır.
    widget_tasks: list[dict[str, Any]] = []
    for d in cost.get("dashboards") or []:
        for i, w in enumerate(d.get("widgets") or []):
            if not w["expands"] or (w.get("real_cost_month") or 0) < MIN_USD:
                continue
            q = next((x for x in w["queries"] if x["expands"]), None)
            widget_tasks.append({
                "id": f"widget-dims:{d['org']}:{d['uid']}:{i}",
                "kind": "widget_dimensions", "severity": "info",
                "title": f"«{d['title']}» → «{w['title']}» sorgusu birden çok metriğe açılıyor",
                "fix": "Sorguda boyut (dimension) tanımlayın ve matchExact'i açın; joker yerine ilgilenilen kaynağı seçin. "
                       "Kaynak bazında ayrı panel, tek panelde joker kullanmaktan hem ucuz hem okunur.",
                "why": (f"Sorgu: {q['text']}" if q else "") + f" · bu widget'ta {w['expands']} sorgu çoğalıyor.",
                "saving_usd": None, "current_usd": round(w.get("real_cost_month") or 0, 2),
                "saving_note": "çekilen metrik sayısı öngörülebilir hale gelir",
                "math": [
                    f"panel payı = dashboard'ın payı × (panelin metriği ÷ dashboard'ın metriği)",
                    f"          = ${d.get('real_cost_month') or 0:,.2f} × ({w.get('metrics_per_refresh') or w['metric_queries']} ÷ {d.get('metrics_per_refresh') or d['cloudwatch_metric']}) = ${w.get('real_cost_month') or 0:,.2f}",
                    f"bu panelde {w['expands']} sorgu joker/boyutsuz olduğu için ölçülen metrik sayısı sorgu sayısından fazla",
                ],
                "where": f"Grafana · dashboard{' · ' + d['folder'] if d['folder'] else ''} · panel «{w['title']}»",
                "links": [{"label": "Sorguyu panelde aç",
                           "url": f"{d['url']}&editPanel={w['panel_id']}" if w.get("panel_id") is not None else d["url"]}],
            })
    widget_tasks.sort(key=lambda t: -(t["current_usd"] or 0))
    tasks += widget_tasks[:8]

    # 6) Log alımı: faturanın büyük kalemi ve artıyorsa
    if bill.get("available"):
        months = [m for m in bill.get("months", []) if not m["partial"]]
        ing = float((bill.get("ingest") or {}).get("cost") or 0)
        if ing >= 10 and len(months) >= 2:
            def ingest_of(m: dict) -> float:
                return sum(i["cost"] for i in m["items"] if "DataProcessing-Bytes" in i["usage_type"])
            first, last = ingest_of(months[0]), ingest_of(months[-1])
            if last > first * 1.3:
                tasks.append({
                    "id": "logs-ingest-growth",
                    "kind": "log_ingest", "severity": "warn",
                    "title": f"Log alımı {months[0]['start'][:7]} → {months[-1]['start'][:7]} arasında ${first:.0f}'dan ${last:.0f}'a çıktı",
                    "fix": "Üç yere bakılmalı: uygulamaların log seviyesi (debug/info prod'da gerekli mi), "
                           "log gruplarının saklama süresi (tanımsız olanlar sınırsız tutuluyor) ve "
                           "AWS servislerinin kendi log teslimleri (ALB, WAF, VPC) gerçekten kullanılıyor mu.",
                    "why": f"Faturanın en büyük tek kalemi: {bill['last_full']['start'][:7]} ayında ${ing:.2f}. "
                           "Sorgu maliyetinden değil, üretilen log hacminden geliyor.",
                    "saving_usd": None, "current_usd": round(ing, 2),
                    "saving_note": "saklama ve seviye ayarıyla doğrudan düşer",
                    "math": [
                        "bu rakam pay değil, faturanın kendisi:",
                        f"DataProcessing-Bytes ({bill['last_full']['start'][:7]}) = ${ing:,.2f}",
                        f"birim fiyat = tutar ÷ GB = ${ing:,.2f} ÷ {(bill.get('ingest') or {}).get('quantity', 0):,.1f} GB"
                        + f" = ${(ing / (bill.get('ingest') or {}).get('quantity', 1)):,.4f}/GB" if (bill.get("ingest") or {}).get("quantity") else "",
                    ],
                    "where": "CloudWatch Logs · log grupları",
                    "links": [{"label": "Log gruplarını aç",
                               "url": f"https://{config.AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region={config.AWS_REGION}#logsV2:log-groups"}],
                })

    tasks.sort(key=lambda t: (-(t["saving_usd"] or 0), -(t["current_usd"] or 0)))
    return tasks


async def state() -> dict[str, dict]:
    return await store.get(DOC)


async def assign(tid: str, name: str | None, task: dict) -> dict | None:
    if name is not None and name not in config.SRE_TEAM:
        raise ValueError("Bu isim ekip listesinde yok")
    now = int(time.time() * 1000)

    def fn(d: dict) -> None:
        if name is None:
            d.pop(tid, None)
        else:
            d[tid] = {"to": name, "at": now, "done_at": None, "title": task.get("title", tid),
                      "saving_usd": task.get("saving_usd"), "kind": task.get("kind")}
        cut = now - KEEP_DAYS * 86_400_000
        for k in [k for k, v in d.items() if v.get("at", 0) < cut]:
            d.pop(k)

    return (await store.update(DOC, fn)).get(tid)


async def set_done(tid: str, done: bool) -> dict:
    now = int(time.time() * 1000)

    def fn(d: dict) -> None:
        if tid not in d:
            raise KeyError(tid)
        d[tid]["done_at"] = now if done else None

    return (await store.update(DOC, fn))[tid]


def merge(tasks: list[dict], st: dict[str, dict]) -> list[dict]:
    """Görevlere atama durumunu ekler."""
    return [{**t, "assignee": st.get(t["id"])} for t in tasks]


def history(st: dict[str, dict], tasks: list[dict] | None = None) -> dict[str, Any]:
    """Tamamlanan görevler ve kazandırdıkları.

    Kayıt, görevin kendisinden değil atama kaydından okunur: bir sorun düzeltildiğinde bulgu
    kaybolur ve görev artık üretilmez. "Kazanç" o anda ölçülmüş aylık tutardır; düzeltme
    yerinde kaldığı sürece her ay tekrar eder.
    """
    now = time.time() * 1000
    live = {t["id"] for t in (tasks or [])}
    done = []
    for tid, a in st.items():
        if not a.get("done_at"):
            continue
        months = max((now - a["done_at"]) / (30 * 86_400_000), 0.0)
        done.append({
            "id": tid, "title": a.get("title") or tid, "kind": a.get("kind"),
            "to": a.get("to"), "done_at": a["done_at"],
            "saving_usd": a.get("saving_usd"),
            "months_since": round(months, 2),
            "accrued_usd": round((a.get("saving_usd") or 0) * months, 2),
            # Bulgu artık üretilmiyorsa düzeltme yerinde duruyor demektir
            "still_fixed": tid not in live,
        })
    done.sort(key=lambda x: -x["done_at"])
    monthly = round(sum(x["saving_usd"] or 0 for x in done), 2)
    return {
        "done": done,
        "count": len(done),
        "monthly_usd": monthly,
        "accrued_usd": round(sum(x["accrued_usd"] for x in done), 2),
        "regressed": [x for x in done if not x["still_fixed"]],
        "first_done_at": min((x["done_at"] for x in done), default=None),
        "open_potential_usd": round(sum(t["saving_usd"] or 0 for t in (tasks or []) if not st.get(t["id"], {}).get("done_at")), 2),
    }
