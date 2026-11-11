"""GPU node'unun gerçek açık kalma süresi ve maliyeti: EKS node group'larının ASG geçmişinden."""
from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone
from typing import Any

from . import config


def _collect() -> dict[str, Any]:
    import boto3  # yalnızca bu modül kullanır

    eks = boto3.client("eks", region_name=config.AWS_REGION)
    asg = boto3.client("autoscaling", region_name=config.AWS_REGION)
    now = datetime.now(timezone.utc)
    window_start = now.timestamp() - config.WINDOW_DAYS * 86400
    groups, sessions, failures = [], [], []
    for ng in eks.list_nodegroups(clusterName=config.GPU_CLUSTER)["nodegroups"]:
        d = eks.describe_nodegroup(clusterName=config.GPU_CLUSTER, nodegroupName=ng)["nodegroup"]
        itype = (d.get("instanceTypes") or ["?"])[0]
        price = config.GPU_PRICES.get(itype)
        names = [a["name"] for a in d.get("resources", {}).get("autoScalingGroups", [])]
        groups.append({"nodegroup": ng, "instance_type": itype, "price_usd_h": price,
                       "desired": d["scalingConfig"].get("desiredSize"), "status": d.get("status")})
        for name in names:
            acts: list[dict] = []
            for page in asg.get_paginator("describe_scaling_activities").paginate(AutoScalingGroupName=name):
                acts += page["Activities"]
            acts.sort(key=lambda a: a["StartTime"])
            open_: dict[str, float] = {}
            for a in acts:
                t = a["StartTime"].timestamp()
                desc = a.get("Description", "")
                m = re.search(r"(i-[0-9a-f]+)", desc)
                if desc.startswith("Launching") and a["StatusCode"] == "Successful" and m:
                    open_[m.group(1)] = t
                elif desc.startswith("Terminating") and a["StatusCode"] == "Successful" and m and m.group(1) in open_:
                    s = open_.pop(m.group(1))
                    sessions.append({"nodegroup": ng, "instance_type": itype, "start": s, "end": t, "price": price})
                elif desc.startswith("Launching") and a["StatusCode"] == "Failed" and t >= window_start:
                    reason = a.get("StatusMessage", "")
                    failures.append({"nodegroup": ng, "instance_type": itype, "t": t,
                                     "reason": "AWS'de kapasite yok" if "InsufficientInstanceCapacity" in reason or "capacity" in reason.lower() else reason[:120]})
            for iid, s in open_.items():
                sessions.append({"nodegroup": ng, "instance_type": itype, "start": s, "end": None, "price": price})
    rows, hours, cost = [], 0.0, 0.0
    for s in sessions:
        end = s["end"] or now.timestamp()
        a, b = max(s["start"], window_start), end
        if b <= window_start:
            continue
        h = (b - a) / 3600
        c = h * (s["price"] or 0)
        hours += h
        cost += c
        rows.append({**s, "start": int(s["start"] * 1000), "end": int(s["end"] * 1000) if s["end"] else None,
                     "hours": round(h, 2), "cost_usd": round(c, 2), "running": s["end"] is None})
    rows.sort(key=lambda r: -r["start"])
    return {"available": True, "fetched_at": int(time.time() * 1000), "cluster": config.GPU_CLUSTER, "nodegroups": groups,
            "sessions": rows, "hours": round(hours, 1), "cost_usd": round(cost, 2),
            "running": any(r["running"] for r in rows),
            "failed_launches": len(failures), "failures": sorted(failures, key=lambda f: -f["t"])[:30]}


async def overview() -> dict[str, Any]:
    try:
        return await asyncio.to_thread(_collect)
    except Exception as exc:  # kimlik bilgisi yoksa portal yine çalışmalı
        return {"available": False, "reason": f"AWS'ye bağlanılamadı: {type(exc).__name__}: {str(exc)[:200]}"}
