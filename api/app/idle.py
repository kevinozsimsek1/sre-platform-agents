"""Kimsenin bakmadığı maliyet: hangi hesapta, hangi bölgede, hangi kaynak para yakıyor.

Buradaki soru "fatura kaç" değil, **"bu şey kullanılıyor mu?"**. İsraf nadiren ana bölgede
olur; çoğu zaman bir kez kurulup unutulmuş bir hesap-bölge çiftinde birikir. Bu yüzden tarama
bütün hesapları ve bütün bölgeleri kapsar, sonra her kaynağın yanına "kullanılıyor mu"
sorusunun **ölçülmüş** cevabını koyar.

Üç kural:

1. **Birim fiyat uydurulmaz.** Her kaynağın tutarı gerçek faturadan türetilir: ilgili kullanım
   tipinin (ör. ``USW2-NatGateway-Hours``) tutarı ÷ miktarı = birim fiyat, sonra kaynağın kendi
   miktarıyla çarpılır. Böylece rakam AWS'nin o ay fiilen uyguladığı orana dayanır.
2. **"Kullanılmıyor" iddiası ölçümle gelir.** Her satırda kararı veren metrik ve değeri yazılıdır
   (ALB istek sayısı, EC2 CPU ve ağ çıkışı, NAT bayt, RDS bağlantı). Ölçüm yoksa "bilinmiyor"
   denir; tahmin edilmez.
3. **Tarama hesap başına tek Cost Explorer isteğidir** ($0,01). Bölge ve kullanım tipi aynı
   istekte iki boyut olarak gruplanır. Geri kalan her çağrı (describe…) ücretsizdir.
"""
from __future__ import annotations

import asyncio
import time
from datetime import date, timedelta
from typing import Any

from . import config

GB = 1_000_000_000
HOURS_MONTH = 730          # fatura ayı yaklaşık; saatlik kalemleri aylığa çevirmek için
LOOKBACK_DAYS = 30
MIN_REGION_USD = 1.0       # bu tutarın altındaki bölge taranmaz: gürültü üretir
MAX_REGIONS = 12
SWEEP_LIMIT = 6            # eşzamanlı bölge taraması


# ----------------------------------------------------------------- hesaplar ve oturum
def accounts() -> list[dict[str, str]]:
    """[{"label": "prod", "profile": "nebim-prod"}, …]

    IDLE_AWS_ACCOUNTS boşsa maliyet profiline düşülür; o da boşsa varsayılan oturum kullanılır
    (cluster'da IRSA bu duruma karşılık gelir).
    """
    raw = config.IDLE_AWS_ACCOUNTS.strip()
    if raw:
        out = []
        for part in raw.split(","):
            label, _, profile = part.partition("=")
            label, profile = label.strip(), profile.strip()
            if label:
                out.append({"label": label, "profile": profile or label})
        if out:
            return out
    p = config.COST_AWS_PROFILE
    return [{"label": p or "varsayılan", "profile": p}]


def _session(profile: str):
    import boto3

    return boto3.Session(profile_name=profile) if profile else boto3.Session()


# ----------------------------------------------------------------- fatura: bölge × kalem
def _bill(profile: str) -> dict[str, Any]:
    """Tek Cost Explorer isteği: bölge ve kullanım tipi iki boyut olarak gruplanır.

    Dönüş: {"regions": {bölge: {kalem: {"cost","qty"}}}, "month": "2026-10", "account": "…"}
    """
    s = _session(profile)
    ce = s.client("ce", region_name="us-east-1")   # Cost Explorer yalnızca us-east-1
    today = date.today()
    first = today.replace(day=1)
    start = (first - timedelta(days=1)).replace(day=1)   # geçen ayın 1'i
    res = ce.get_cost_and_usage(
        TimePeriod={"Start": start.isoformat(), "End": (today + timedelta(days=1)).isoformat()},
        Granularity="MONTHLY",
        Metrics=["UnblendedCost", "UsageQuantity"],
        GroupBy=[{"Type": "DIMENSION", "Key": "REGION"}, {"Type": "DIMENSION", "Key": "USAGE_TYPE"}],
    )
    months: list[dict[str, Any]] = []
    for p in res["ResultsByTime"]:
        regions: dict[str, dict[str, dict[str, float]]] = {}
        for g in p["Groups"]:
            region, ut = g["Keys"]
            cost = float(g["Metrics"]["UnblendedCost"]["Amount"])
            qty = float(g["Metrics"]["UsageQuantity"]["Amount"])
            if cost < 0.005 and qty <= 0:
                continue
            regions.setdefault(region, {})[ut] = {"cost": round(cost, 4), "qty": qty}
        months.append({
            "start": p["TimePeriod"]["Start"], "end": p["TimePeriod"]["End"],
            "partial": p["TimePeriod"]["End"] > today.isoformat(),
            "regions": regions,
        })
    account = None
    try:
        account = s.client("sts").get_caller_identity()["Account"]
    except Exception:  # noqa: BLE001 — hesap kimliği gösterim için, zorunlu değil
        pass
    full = [m for m in months if not m["partial"]]
    return {"months": months, "last_full": full[-1] if full else months[-1],
            "current": months[-1], "account": account}


def _rate(items: dict[str, dict[str, float]], *fragments: str) -> tuple[float, float, float]:
    """Kalem ailesinin (tutar, miktar, birim fiyat)'ı. Bölge öneki (USW2-…) yok sayılır."""
    cost = qty = 0.0
    for ut, v in items.items():
        bare = ut.split("-", 1)[-1] if "-" in ut else ut
        if any(f in bare or f in ut for f in fragments):
            cost += v["cost"]
            qty += v["qty"]
    return round(cost, 4), qty, (cost / qty if qty else 0.0)


# ----------------------------------------------------------------- kaynak taraması
def _tag(tags: list[dict] | None, key: str = "Name") -> str | None:
    for t in tags or []:
        if t.get("Key") == key:
            return t.get("Value")
    return None


def _metrics(cw, queries: list[dict], days: int) -> dict[str, float]:
    """GetMetricData: {id: toplam/ortalama}. Boş sonuç 0 değil, eksik sayılır."""
    if not queries:
        return {}
    end = int(time.time())
    start = end - days * 86400
    out: dict[str, float] = {}
    for i in range(0, len(queries), 450):
        batch = queries[i:i + 450]
        token = None
        while True:
            kw: dict[str, Any] = {"MetricDataQueries": batch, "StartTime": start, "EndTime": end}
            if token:
                kw["NextToken"] = token
            res = cw.get_metric_data(**kw)
            for r in res.get("MetricDataResults", []):
                vals = r.get("Values") or []
                if vals:
                    out[r["Id"]] = out.get(r["Id"], 0.0) + sum(vals)
            token = res.get("NextToken")
            if not token:
                break
    return out


def _q(mid: str, ns: str, name: str, dims: dict[str, str], stat: str, days: int) -> dict:
    return {"Id": mid, "ReturnData": True, "MetricStat": {
        "Metric": {"Namespace": ns, "MetricName": name,
                   "Dimensions": [{"Name": k, "Value": v} for k, v in dims.items()]},
        "Period": days * 86400, "Stat": stat}}


def _ports(sg: dict) -> list[str]:
    """Bir güvenlik grubunun dünyaya açık portları: "bu şey dışarıya bakıyor mu" sorusu."""
    out = []
    for p in sg.get("IpPermissions", []):
        world = any(r.get("CidrIp") == "0.0.0.0/0" for r in p.get("IpRanges", []))
        if not world:
            continue
        lo, hi = p.get("FromPort"), p.get("ToPort")
        proto = p.get("IpProtocol")
        out.append("tüm portlar" if proto == "-1" else (str(lo) if lo == hi else f"{lo}-{hi}"))
    return out


def _sweep(profile: str, region: str, items: dict[str, dict[str, float]]) -> list[dict[str, Any]]:
    """Bir bölgedeki para yakan kaynaklar + her birinin "kullanılıyor mu" kanıtı.

    Her satıra ayrıca "ne içeriyor" dökümü konur (``contents``): makinede hangi diskler ve
    açık portlar, yük dengeleyicide hangi hedefler ve sağlıkları, Fargate servisinde hangi
    imaj, NAT'ın VPC'sinde ne olduğu. Kararı veren bilgi çoğu zaman kaynağın kendisinde değil
    içindekinde: boş hedef grubu olan bir ALB "çalışıyor" görünür ama kimseye hizmet etmez.
    """
    s = _session(profile)
    ec2 = s.client("ec2", region_name=region)
    cw = s.client("cloudwatch", region_name=region)
    found: list[dict[str, Any]] = []
    queries: list[dict] = []

    def add(**kw) -> dict[str, Any]:
        kw.setdefault("flags", [])
        kw.setdefault("evidence", None)
        kw.setdefault("usd_month", 0.0)
        kw.setdefault("contents", [])
        found.append(kw)
        return kw

    # Güvenlik grupları ve VPC adları bir kez okunur; birden çok kaynak bunlara bakıyor.
    sgs: dict[str, dict] = {}
    vpc_names: dict[str, str] = {}
    try:
        for page in ec2.get_paginator("describe_security_groups").paginate():
            for g in page.get("SecurityGroups", []):
                sgs[g["GroupId"]] = g
    except Exception:  # noqa: BLE001
        pass
    try:
        for v in ec2.describe_vpcs().get("Vpcs", []):
            vpc_names[v["VpcId"]] = _tag(v.get("Tags")) or ""
    except Exception:  # noqa: BLE001
        pass

    # --- EC2 makineleri ------------------------------------------------------------
    ebs_cost, ebs_gb, ebs_rate = _rate(items, "EBS:VolumeUsage")
    insts: dict[str, dict] = {}
    try:
        for page in ec2.get_paginator("describe_instances").paginate():
            for r in page.get("Reservations", []):
                for i in r.get("Instances", []):
                    insts[i["InstanceId"]] = i
    except Exception:  # noqa: BLE001 — yetki yoksa bu tür atlanır
        insts = {}
    for iid, i in insts.items():
        itype, state = i["InstanceType"], i["State"]["Name"]
        box_cost, box_qty, box_rate = _rate(items, f"BoxUsage:{itype}")
        row = add(kind="ec2", id=iid, name=_tag(i.get("Tags")) or iid, region=region,
                  detail=f"{itype} · {state}", vpc=i.get("VpcId"),
                  since=i.get("LaunchTime").isoformat() if i.get("LaunchTime") else None,
                  usd_month=round(box_rate * HOURS_MONTH, 2) if state == "running" else 0.0,
                  basis=f"BoxUsage:{itype} faturadan ${box_rate:.4f}/saat × {HOURS_MONTH} saat"
                        if state == "running" and box_rate else None)
        # Ne içeriyor: diskler, açık portlar, hangi ağda durduğu
        disks = [f"{d['Ebs']['VolumeId']} ({d.get('DeviceName', '?')})"
                 for d in i.get("BlockDeviceMappings", []) if d.get("Ebs")]
        if disks:
            row["contents"].append({"label": "Diskler", "value": ", ".join(disks[:6])})
        open_ports: list[str] = []
        for g in i.get("SecurityGroups", []):
            open_ports += _ports(sgs.get(g["GroupId"], {}))
        row["contents"].append({
            "label": "Dışarıya açık portlar",
            "value": ", ".join(sorted(set(open_ports))) if open_ports else "yok (yalnızca iç ağdan erişilir)"})
        if i.get("VpcId"):
            row["contents"].append({"label": "Ağ", "value": f"{i['VpcId']}"
                                    + (f" ({vpc_names[i['VpcId']]})" if vpc_names.get(i["VpcId"]) else "")
                                    + f" · {i.get('SubnetId', '')}"})
        if i.get("ImageId"):
            row["contents"].append({"label": "İmaj", "value": i["ImageId"]})
        if state == "stopped":
            row["flags"].append("durduruldu")
            row["detail"] = f"{itype} · durduruldu (işlemci ücreti yok, diski duruyor)"
            if box_cost > 0.01:
                row["flags"].append("bu ay calisti")
                row["note"] = (f"Bu kesitte {itype} için faturada ${box_cost:.2f} ({box_qty:.0f} saat) var: "
                               "ay içinde bir süre açık kalmış.")
        elif state == "running":
            queries.append(_q(f"cpu_{len(queries)}", "AWS/EC2", "CPUUtilization",
                              {"InstanceId": iid}, "Average", LOOKBACK_DAYS))
            row["_cpu"] = f"cpu_{len(queries) - 1}"
            queries.append(_q(f"net_{len(queries)}", "AWS/EC2", "NetworkOut",
                              {"InstanceId": iid}, "Sum", LOOKBACK_DAYS))
            row["_net"] = f"net_{len(queries) - 1}"

    # --- EBS diskleri -------------------------------------------------------------
    try:
        for page in ec2.get_paginator("describe_volumes").paginate():
            for v in page.get("Volumes", []):
                att = (v.get("Attachments") or [{}])[0].get("InstanceId")
                gb = v["Size"]
                usd = round(ebs_rate * gb, 2)
                if not att:
                    add(kind="ebs", id=v["VolumeId"], name=_tag(v.get("Tags")) or v["VolumeId"],
                        region=region, detail=f"{gb} GB {v['VolumeType']} · hiçbir makineye bağlı değil",
                        usd_month=usd, flags=["bagli degil"],
                        evidence="Bağlı olmadığı için hiç okunup yazılmıyor; yalnızca yer tutuyor.",
                        basis=f"EBS:VolumeUsage faturadan ${ebs_rate:.4f}/GB-ay × {gb} GB")
                elif (insts.get(att, {}).get("State", {}).get("Name")) == "stopped":
                    add(kind="ebs", id=v["VolumeId"], name=_tag(v.get("Tags")) or v["VolumeId"],
                        region=region,
                        detail=f"{gb} GB {v['VolumeType']} · durdurulmuş makinede ({att})",
                        usd_month=usd, flags=["durmus makinede"],
                        evidence="Makine kapalı ama disk ücreti işliyor. Makine bir daha açılmayacaksa anlık görüntü alıp silinebilir.",
                        basis=f"EBS:VolumeUsage faturadan ${ebs_rate:.4f}/GB-ay × {gb} GB")
    except Exception:  # noqa: BLE001
        pass

    # --- NAT gateway'ler ----------------------------------------------------------
    nat_h_cost, nat_h_qty, nat_h_rate = _rate(items, "NatGateway-Hours")
    nat_b_cost, nat_b_qty, _ = _rate(items, "NatGateway-Bytes")
    try:
        nats = [n for n in ec2.describe_nat_gateways().get("NatGateways", [])
                if n.get("State") == "available"]
    except Exception:  # noqa: BLE001
        nats = []
    for n in nats:
        row = add(kind="nat", id=n["NatGatewayId"], name=_tag(n.get("Tags")) or n["NatGatewayId"],
                  region=region, vpc=n.get("VpcId"),
                  since=n.get("CreateTime").isoformat() if n.get("CreateTime") else None,
                  detail=f"VPC {n.get('VpcId')}",
                  usd_month=round(nat_h_rate * HOURS_MONTH, 2),
                  basis=f"NatGateway-Hours faturadan ${nat_h_rate:.4f}/saat × {HOURS_MONTH} saat")
        if nat_h_cost and nat_b_cost / max(nat_h_cost + nat_b_cost, 0.0001) < 0.1:
            row["flags"].append("sabit ucret baskin")
            n_count = len(nats)
            levers = ("S3 ve DynamoDB için ağ geçidi uç noktası (gateway endpoint) ücretsizdir ve o trafiği "
                      "NAT'tan tamamen çıkarır — ama veri ücretini düşürür, saatlik ücreti düşürmez. "
                      "Saatlik ücret ancak NAT sayısı azaltılarak düşer.")
            if n_count > 1:
                levers += (f" Bu bölgede {n_count} NAT var: her biri ayrı erişilebilirlik bölgesinde "
                           f"yedeklilik sağlıyorsa gereklidir; değilse tek NAT'a inmek "
                           f"ayda ${nat_h_rate * HOURS_MONTH:.2f} kazandırır.")
            row["note"] = (f"Bölgedeki NAT faturası ${nat_h_cost + nat_b_cost:.2f}; bunun "
                           f"${nat_h_cost:.2f}'ı sadece var olma ücreti, veri işleme yalnızca "
                           f"${nat_b_cost:.2f} ({nat_b_qty:.1f} GB). {levers}")
        queries.append(_q(f"nat_{len(queries)}", "AWS/NATGateway", "BytesOutToDestination",
                          {"NatGatewayId": n["NatGatewayId"]}, "Sum", LOOKBACK_DAYS))
        row["_nat"] = f"nat_{len(queries) - 1}"

    # --- Public IPv4 / Elastic IP -------------------------------------------------
    ip_cost, ip_qty, ip_rate = _rate(items, "PublicIPv4:")
    try:
        addrs = ec2.describe_addresses().get("Addresses", [])
    except Exception:  # noqa: BLE001
        addrs = []
    loose = [a for a in addrs if not a.get("AssociationId")]
    for a in loose:
        add(kind="eip", id=a.get("AllocationId") or a["PublicIp"],
            name=_tag(a.get("Tags")) or a["PublicIp"], region=region,
            detail=f"{a['PublicIp']} · hiçbir şeye bağlı değil",
            usd_month=round(ip_rate * HOURS_MONTH, 2) if ip_rate else 0.0,
            flags=["bosta"],
            evidence="Boşta duran Elastic IP, kullanılmadığı halde saat başı ücretlendirilir.",
            basis=f"PublicIPv4 faturadan ${ip_rate:.6f}/adres-saat × {HOURS_MONTH} saat" if ip_rate else None)
    if ip_cost > 0.5:
        add(kind="ipv4", id=f"{region}:ipv4", name="Public IPv4 adresleri", region=region,
            detail=f"{ip_qty / HOURS_MONTH:.0f} adres · {len(addrs)} Elastic IP tanımlı",
            usd_month=round(ip_cost, 2), flags=[],
            evidence="AWS 2024'ten beri bağlı olsun olmasın her genel IPv4 adresini saat başı ücretlendiriyor.",
            basis=f"PublicIPv4:InUseAddress kalemi: {ip_qty:.0f} adres-saat × ${ip_rate:.6f}")

    # --- Yük dengeleyiciler -------------------------------------------------------
    alb_cost, alb_qty, alb_rate = _rate(items, "LoadBalancerUsage")
    try:
        elb = s.client("elbv2", region_name=region)
        lbs = elb.describe_load_balancers().get("LoadBalancers", [])
    except Exception:  # noqa: BLE001
        lbs = []
    for lb in lbs:
        suffix = lb["LoadBalancerArn"].split("loadbalancer/")[-1]
        row = add(kind="elb", id=lb["LoadBalancerName"], name=lb["LoadBalancerName"], region=region,
                  vpc=lb.get("VpcId"),
                  since=lb["CreatedTime"].isoformat() if lb.get("CreatedTime") else None,
                  detail=f"{lb.get('Type', '?')} · {lb.get('State', {}).get('Code', '?')}",
                  usd_month=round(alb_rate * HOURS_MONTH, 2) if alb_rate else 0.0,
                  basis=f"LoadBalancerUsage faturadan ${alb_rate:.4f}/saat × {HOURS_MONTH} saat" if alb_rate else None)
        # Ne içeriyor: dinleyiciler ve hedefler. Boş hedef grubu olan ALB "active" görünür
        # ama kimseye hizmet etmez; bu ayrımı yalnızca içine bakarak görebiliyoruz.
        try:
            listeners = elb.describe_listeners(LoadBalancerArn=lb["LoadBalancerArn"]).get("Listeners", [])
            if listeners:
                row["contents"].append({
                    "label": "Dinleyiciler",
                    "value": ", ".join(f"{l.get('Protocol')}:{l.get('Port')}" for l in listeners[:6])})
            tgs = elb.describe_target_groups(LoadBalancerArn=lb["LoadBalancerArn"]).get("TargetGroups", [])
            empty = 0
            for tg in tgs[:8]:
                try:
                    hs = elb.describe_target_health(TargetGroupArn=tg["TargetGroupArn"]).get("TargetHealthDescriptions", [])
                except Exception:  # noqa: BLE001
                    hs = []
                healthy = sum(1 for h in hs if h.get("TargetHealth", {}).get("State") == "healthy")
                if not hs:
                    empty += 1
                row["contents"].append({
                    "label": f"Hedef grubu {tg['TargetGroupName']}",
                    "value": (f"{len(hs)} hedef, {healthy} sağlıklı · {tg.get('Protocol')}:{tg.get('Port')}"
                              if hs else f"hiç hedef yok · {tg.get('Protocol')}:{tg.get('Port')}")})
            if tgs and empty == len(tgs[:8]):
                row["flags"].append("hedefsiz")
        except Exception:  # noqa: BLE001
            pass
        ns = "AWS/ApplicationELB" if lb.get("Type") == "application" else "AWS/NetworkELB"
        queries.append(_q(f"req_{len(queries)}", ns,
                          "RequestCount" if ns.endswith("ApplicationELB") else "ActiveFlowCount",
                          {"LoadBalancer": suffix}, "Sum", LOOKBACK_DAYS))
        row["_req"] = f"req_{len(queries) - 1}"

    # --- ECS servisleri -----------------------------------------------------------
    taskdefs: dict[str, dict] = {}
    try:
        ecs = s.client("ecs", region_name=region)
        for carn in ecs.list_clusters().get("clusterArns", []):
            cname = carn.split("/")[-1]
            sarns = ecs.list_services(cluster=carn).get("serviceArns", [])
            if not sarns:
                add(kind="ecs", id=cname, name=cname, region=region,
                    detail="cluster duruyor, içinde hiç servis yok", usd_month=0.0,
                    flags=["bos cluster"],
                    evidence="Boş ECS cluster'ı ücretsizdir; yalnızca kalıntı olduğu için listelenir.")
                continue
            for j in range(0, len(sarns), 10):
                for sv in ecs.describe_services(cluster=carn, services=sarns[j:j + 10]).get("services", []):
                    desired, running = sv.get("desiredCount", 0), sv.get("runningCount", 0)
                    row = add(kind="ecs", id=f"{cname}/{sv['serviceName']}", name=sv["serviceName"],
                              region=region, detail=f"{cname} · {running}/{desired} task",
                              since=sv["createdAt"].isoformat() if sv.get("createdAt") else None,
                              evidence=f"İstenen task sayısı {desired}, çalışan {running}.")
                    # Ne içeriyor: hangi imaj, ne kadar CPU/RAM ayrılmış, hangi ağda
                    tdarn = sv.get("taskDefinition")
                    if tdarn and tdarn not in taskdefs:
                        try:
                            taskdefs[tdarn] = ecs.describe_task_definition(taskDefinition=tdarn)["taskDefinition"]
                        except Exception:  # noqa: BLE001
                            taskdefs[tdarn] = {}
                    td = taskdefs.get(tdarn) or {}
                    for c in (td.get("containerDefinitions") or [])[:6]:
                        size = " · ".join(x for x in [
                            f"{c['cpu']} CPU birimi" if c.get("cpu") else "",
                            f"{c['memory']} MB" if c.get("memory") else "",
                            f"{c['memoryReservation']} MB (yumuşak)" if c.get("memoryReservation") else "",
                        ] if x)
                        row["contents"].append({
                            "label": f"Konteyner {c.get('name', '?')}",
                            "value": f"{c.get('image', '?')}" + (f" · {size}" if size else "")})
                    if td.get("cpu") or td.get("memory"):
                        row["contents"].append({
                            "label": "Task boyutu",
                            "value": f"{int(td.get('cpu', 0)) / 1024:g} vCPU · {int(td.get('memory', 0)) / 1024:g} GB"
                                     + (f" · {td.get('runtimePlatform', {}).get('cpuArchitecture', '')}"
                                        if td.get("runtimePlatform") else "")})
                    if sv.get("launchType"):
                        row["contents"].append({"label": "Çalışma biçimi", "value": sv["launchType"]})
                    if desired == 0:
                        row["flags"].append("0 task")
                        row["evidence"] = ("Servis tanımlı ama hiç task istemiyor: compute ücreti yok, "
                                           "bağlı ALB ve NAT ücreti işlemeye devam ediyor.")
    except Exception:  # noqa: BLE001
        pass

    # --- RDS ----------------------------------------------------------------------
    try:
        rds = s.client("rds", region_name=region)
        for db in rds.describe_db_instances().get("DBInstances", []):
            cls = db.get("DBInstanceClass", "")
            d_cost, d_qty, d_rate = _rate(items, f"InstanceUsage:{cls.replace('db.', '')}")
            row = add(kind="rds", id=db["DBInstanceIdentifier"], name=db["DBInstanceIdentifier"],
                      region=region, detail=f"{cls} · {db.get('DBInstanceStatus')}",
                      usd_month=round(d_rate * HOURS_MONTH, 2) if d_rate else 0.0,
                      basis=f"InstanceUsage faturadan ${d_rate:.4f}/saat × {HOURS_MONTH} saat" if d_rate else None)
            queries.append(_q(f"con_{len(queries)}", "AWS/RDS", "DatabaseConnections",
                              {"DBInstanceIdentifier": db["DBInstanceIdentifier"]}, "Sum", LOOKBACK_DAYS))
            row["_con"] = f"con_{len(queries) - 1}"
    except Exception:  # noqa: BLE001
        pass

    # --- Anlık görüntüler ---------------------------------------------------------
    snap_cost, snap_qty, snap_rate = _rate(items, "EBS:SnapshotUsage", "EBS:directAPI")
    if snap_cost > 0.5:
        try:
            old = date.today() - timedelta(days=180)
            snaps = []
            for page in ec2.get_paginator("describe_snapshots").paginate(OwnerIds=["self"]):
                snaps.extend(page.get("Snapshots", []))
            stale = [x for x in snaps if x["StartTime"].date() < old]
            if stale:
                add(kind="snapshot", id=f"{region}:snapshots", name="Eski anlık görüntüler",
                    region=region,
                    detail=f"{len(stale)} / {len(snaps)} görüntü 6 aydan eski · {sum(x['VolumeSize'] for x in stale)} GB kaynak hacim",
                    usd_month=round(snap_cost * len(stale) / max(len(snaps), 1), 2),
                    flags=["eski goruntu"],
                    evidence="Anlık görüntüler artımlıdır; tutar kaynak hacme değil değişen bloklara göredir, bu yüzden pay olarak verilir.",
                    basis=f"EBS:SnapshotUsage kalemi ${snap_cost:.2f}, eski görüntü oranıyla paylaştırıldı")
        except Exception:  # noqa: BLE001
            pass

    # --- NAT'ın VPC'sinde ne var --------------------------------------------------
    # VPC'de para yakan hemen her şeyin bir ağ arayüzü vardır; tek çağrıyla envanter çıkar.
    # NAT'ı kaldırıp kaldıramayacağımız, o VPC'de internete çıkması gereken bir şey kalıp
    # kalmadığına bağlı — karar bu listeyle veriliyor.
    if nats:
        try:
            enis: dict[str, list[dict]] = {}
            for page in ec2.get_paginator("describe_network_interfaces").paginate():
                for e in page.get("NetworkInterfaces", []):
                    enis.setdefault(e.get("VpcId") or "?", []).append(e)
        except Exception:  # noqa: BLE001
            enis = {}
        for row in found:
            if row["kind"] != "nat":
                continue
            mine = enis.get(row.get("vpc") or "?", [])
            kinds: dict[str, int] = {}
            for e in mine:
                desc = e.get("Description") or ""
                if e.get("InterfaceType") == "nat_gateway":
                    k = "NAT gateway"
                elif desc.startswith("ELB"):
                    k = "yük dengeleyici"
                elif ":ecs:" in desc or desc.startswith("arn:aws:ecs"):
                    k = "Fargate task"
                elif e.get("Attachment", {}).get("InstanceId"):
                    k = "EC2 makinesi"
                elif "RDSNetworkInterface" in desc or desc.startswith("RDS"):
                    k = "RDS"
                elif "Lambda" in desc or "AWS Lambda" in desc:
                    k = "Lambda"
                else:
                    k = "diğer arayüz"
                kinds[k] = kinds.get(k, 0) + 1
            row["contents"].append({
                "label": "VPC'de ne var",
                "value": ", ".join(f"{n} × {k}" for k, n in sorted(kinds.items(), key=lambda x: -x[1]))
                         or "hiçbir ağ arayüzü yok"})
            if row.get("vpc") and vpc_names.get(row["vpc"]):
                row["contents"].append({"label": "VPC adı", "value": vpc_names[row["vpc"]]})
            # NAT'a gerçekten ihtiyacı olabilecek şeyler: özel ağdan internete çıkanlar
            needs = kinds.get("Fargate task", 0) + kinds.get("EC2 makinesi", 0) + kinds.get("Lambda", 0)
            if needs == 0:
                row["flags"].append("vpc bos")
                row["contents"].append({
                    "label": "Sonuç",
                    "value": "Bu VPC'de internete çıkması gereken hiçbir iş yükü kalmamış: NAT'ın karşılığı yok."})
            else:
                row["contents"].append({
                    "label": "Sonuç",
                    "value": f"{needs} iş yükü bu NAT üzerinden internete çıkıyor olabilir; "
                             "kaldırmadan önce bunların dışarıya neye eriştiği kontrol edilmeli."})

    # --- "kullanılıyor mu" ölçümlerini bağla --------------------------------------
    vals = _metrics(cw, queries, LOOKBACK_DAYS) if queries else {}
    for row in found:
        cpu, net = row.pop("_cpu", None), row.pop("_net", None)
        req, nat, con = row.pop("_req", None), row.pop("_nat", None), row.pop("_con", None)
        if cpu or net:
            c, n = vals.get(cpu or ""), vals.get(net or "")
            if c is None and n is None:
                row["evidence"] = "Son 30 günde CloudWatch'ta ölçüm yok; kullanıldığı söylenemez, kullanılmadığı da."
            else:
                row["evidence"] = (f"Son 30 gün: ortalama işlemci %{c or 0:.1f}, ağ çıkışı "
                                   f"{(n or 0) / GB:.2f} GB.")
                if (c or 0) < 2 and (n or 0) < 0.1 * GB:
                    row["flags"].append("atil")
        if req is not None:
            v = vals.get(req)
            if v is None:
                row["evidence"] = "Son 30 günde istek metriği yok."
                row["flags"].append("olcum yok")
            elif v == 0:
                row["evidence"] = "Son 30 günde hiç istek almadı."
                row["flags"].append("istek yok")
            else:
                row["evidence"] = f"Son 30 günde {v:,.0f} istek aldı (günde ~{v / 30:,.0f}).".replace(",", ".")
        if nat is not None:
            v = vals.get(nat)
            row["evidence"] = (f"Son 30 günde dışarıya {(v or 0) / GB:.2f} GB geçti."
                               if v is not None else "Son 30 günde NAT trafiği ölçümü yok.")
        if con is not None:
            v = vals.get(con)
            if v is None:
                row["evidence"] = "Son 30 günde bağlantı metriği yok."
            elif v == 0:
                row["evidence"] = "Son 30 günde hiç veritabanı bağlantısı açılmadı."
                row["flags"].append("baglanti yok")
            else:
                row["evidence"] = f"Son 30 günde {v:,.0f} bağlantı açıldı.".replace(",", ".")
    return found


# ----------------------------------------------------------------- toplama
def _collect_account(acct: dict[str, str]) -> dict[str, Any]:
    bill = _bill(acct["profile"])
    last = bill["last_full"]
    skip = {"NoRegion", "global", "Any"}
    ranked = sorted(
        ((r, sum(v["cost"] for v in items.values()), items) for r, items in last["regions"].items() if r not in skip),
        key=lambda x: -x[1])
    regions: list[dict[str, Any]] = []
    sweeps: list[tuple[str, dict]] = []
    for name, total, items in ranked[:MAX_REGIONS]:
        cur = bill["current"]["regions"].get(name, {})
        regions.append({
            "region": name, "usd_last_full": round(total, 2),
            "usd_current": round(sum(v["cost"] for v in cur.values()), 2),
            "items": sorted(({"usage_type": ut, "cost": round(v["cost"], 2), "qty": v["qty"]}
                             for ut, v in items.items() if v["cost"] >= 0.01),
                            key=lambda x: -x["cost"])[:25],
            "swept": total >= MIN_REGION_USD,
        })
        if total >= MIN_REGION_USD:
            sweeps.append((name, items))
    other = round(sum(t for _, t, _ in ranked[MAX_REGIONS:]), 2)
    resources: list[dict[str, Any]] = []
    for name, items in sweeps:
        try:
            for row in _sweep(acct["profile"], name, items):
                row["account"] = acct["label"]
                resources.append(row)
        except Exception as exc:  # noqa: BLE001 — bir bölge okunamazsa diğerleri yine gelsin
            resources.append({"kind": "hata", "id": f"{name}:hata", "name": name, "region": name,
                              "account": acct["label"], "usd_month": 0.0, "flags": ["okunamadi"],
                              "detail": f"{type(exc).__name__}: {str(exc)[:160]}", "evidence": None})
    return {
        "label": acct["label"], "account": bill["account"],
        "month": last["start"][:7], "current_month": bill["current"]["start"][:7],
        "usd_last_full": round(sum(r["usd_last_full"] for r in regions) + other, 2),
        "regions": regions, "other_regions_usd": other, "resources": resources,
        "home_region": config.AWS_REGION,
    }


def _collect() -> dict[str, Any]:
    out: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for a in accounts():
        try:
            out.append(_collect_account(a))
        except Exception as exc:  # noqa: BLE001 — bir hesap okunamazsa diğeri yine gelsin
            errors.append({"label": a["label"], "reason": f"{type(exc).__name__}: {str(exc)[:200]}"})
    if not out:
        return {"available": False,
                "reason": errors[0]["reason"] if errors else "Hiçbir hesap okunamadı.",
                "errors": errors}

    res = [r for a in out for r in a["resources"]]
    flagged = [r for r in res if r.get("flags") and "okunamadi" not in r["flags"]]
    # "Ana bölge dışı": israf çoğunlukla burada. Ev bölgesi ekibin her gün baktığı yer.
    away = [{"account": a["label"], "region": r["region"], "usd": r["usd_last_full"]}
            for a in out for r in a["regions"]
            if r["region"] != a["home_region"] and r["usd_last_full"] >= MIN_REGION_USD]
    away.sort(key=lambda x: -x["usd"])
    return {
        "available": True,
        "fetched_at": int(time.time() * 1000),
        "window_days": LOOKBACK_DAYS,
        "accounts": out,
        "errors": errors,
        "summary": {
            "accounts": len(out),
            "regions": sum(len(a["regions"]) for a in out),
            "usd_last_full": round(sum(a["usd_last_full"] for a in out), 2),
            "away_regions": len(away),
            "away_usd": round(sum(x["usd"] for x in away), 2),
            "away": away[:10],
            "flagged": len(flagged),
            "flagged_usd": round(sum(r.get("usd_month") or 0 for r in flagged), 2),
        },
    }


async def overview() -> dict[str, Any]:
    try:
        return await asyncio.to_thread(_collect)
    except Exception as exc:  # noqa: BLE001 — sayfa açıklama gösterir
        return {"available": False, "reason": f"{type(exc).__name__}: {str(exc)[:200]}"}
