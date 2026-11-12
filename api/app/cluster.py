"""Prod cluster'ın şu anki durumu (kube-state-metrics, node-exporter, cAdvisor, cert-manager; Prometheus).

Alert gelmesini beklemeden ya da kubectl açmadan sabah bakılacak tablo: sorunlu pod'lar, restart'lar,
node doluluğu, ayrılan ve kullanılan kaynak, süresi dolacak sertifikalar, dolan diskler.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from . import grafana

C = 'container!="",container!="POD"'

Q: dict[str, str] = {
    "nodes": "kube_node_info",
    "ready": 'kube_node_status_condition{condition="Ready",status="true"} == 1',
    "pressure": 'kube_node_status_condition{condition=~"MemoryPressure|DiskPressure|PIDPressure",status="true"} == 1',
    "node_cpu": '(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) * on (instance) group_left (nodename) node_uname_info',
    "node_mem": "(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * on (instance) group_left (nodename) node_uname_info",
    "req_cpu": 'sum by (node) (kube_pod_container_resource_requests{resource="cpu"} * on (namespace, pod) group_left () (kube_pod_status_phase{phase="Running"} == 1))',
    "req_mem": 'sum by (node) (kube_pod_container_resource_requests{resource="memory"} * on (namespace, pod) group_left () (kube_pod_status_phase{phase="Running"} == 1))',
    "alloc_cpu": 'sum by (node) (kube_node_status_allocatable{resource="cpu"})',
    "alloc_mem": 'sum by (node) (kube_node_status_allocatable{resource="memory"})',
    "pods_node": 'count by (node) (kube_pod_info * on (namespace, pod) group_left () (kube_pod_status_phase{phase="Running"} == 1))',
    "alloc_pods": 'sum by (node) (kube_node_status_allocatable{resource="pods"})',
    "waiting": "kube_pod_container_status_waiting_reason == 1",
    "phase": 'kube_pod_status_phase{phase=~"Pending|Failed|Unknown"} == 1',
    "restarts": "topk(20, sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[24h]))) >= 1",
    "oom": 'kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1',
    "deploy": "kube_deployment_status_replicas_unavailable > 0",
    "sts": "(kube_statefulset_replicas - kube_statefulset_status_replicas_ready) > 0",
    "ds": "kube_daemonset_status_number_unavailable > 0",
    "jobs": "kube_job_status_failed > 0",
    "hpa_max": "(kube_horizontalpodautoscaler_status_current_replicas >= on (namespace, horizontalpodautoscaler) kube_horizontalpodautoscaler_spec_max_replicas)",
    "certs": "(certmanager_certificate_expiration_timestamp_seconds - time()) / 86400",
    "pvc": "kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes",
    "ns_cpu_use": f"sum by (namespace) (rate(container_cpu_usage_seconds_total{{{C}}}[30m]))",
    "ns_cpu_req": 'sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"} * on (namespace, pod) group_left () (kube_pod_status_phase{phase="Running"} == 1))',
    "ns_mem_use": f"sum by (namespace) (container_memory_working_set_bytes{{{C}}})",
    "ns_mem_req": 'sum by (namespace) (kube_pod_container_resource_requests{resource="memory"} * on (namespace, pod) group_left () (kube_pod_status_phase{phase="Running"} == 1))',
}

SYSTEM_NS = {"kube-system", "kube-public", "kube-node-lease"}


async def _q(q: str) -> list[dict]:
    try:
        return await grafana.prom(q)
    except Exception:  # noqa: BLE001 — bir sorgu düşerse sayfanın kalanı yine gelsin
        return []


def _v(r: dict) -> float:
    try:
        return float(r["value"][1])
    except (KeyError, ValueError, IndexError):
        return 0.0


def _by(rows: list[dict], label: str) -> dict[str, float]:
    return {r["metric"].get(label, ""): _v(r) for r in rows}


def _pod_cmds(ns: str, pod: str) -> list[str]:
    return [f"kubectl -n {ns} describe pod {pod}", f"kubectl -n {ns} logs {pod} --all-containers --previous --tail=200"]


async def overview() -> dict[str, Any]:
    keys = list(Q)
    res = dict(zip(keys, await asyncio.gather(*(_q(Q[k]) for k in keys))))

    # ---------------------------------------------------------- node'lar
    ready = {r["metric"].get("node") for r in res["ready"]}
    pressure: dict[str, list[str]] = {}
    for r in res["pressure"]:
        pressure.setdefault(r["metric"].get("node", ""), []).append(r["metric"].get("condition", ""))
    cpu, mem = _by(res["node_cpu"], "nodename"), _by(res["node_mem"], "nodename")
    rc, rm, ac, am = (_by(res[k], "node") for k in ("req_cpu", "req_mem", "alloc_cpu", "alloc_mem"))
    pn, ap = _by(res["pods_node"], "node"), _by(res["alloc_pods"], "node")
    nodes = []
    for r in res["nodes"]:
        n = r["metric"].get("node", "")
        nodes.append({
            "node": n, "ready": n in ready, "pressure": pressure.get(n, []),
            "cpu_used": cpu.get(n), "mem_used": mem.get(n),
            "cpu_requested": rc.get(n, 0) / ac[n] if ac.get(n) else None,
            "mem_requested": rm.get(n, 0) / am[n] if am.get(n) else None,
            "pods": int(pn.get(n, 0)), "pods_max": int(ap.get(n, 0)) or None,
            "cmds": [f"kubectl describe node {n}", f"kubectl top node {n}"],
        })
    nodes.sort(key=lambda x: x["node"])

    # ---------------------------------------------------------- sorunlu pod'lar
    pods: dict[tuple[str, str], dict] = {}

    def add(ns: str, pod: str, problem: str, detail: str = "") -> None:
        p = pods.setdefault((ns, pod), {"namespace": ns, "pod": pod, "problems": [], "restarts_24h": 0, "cmds": _pod_cmds(ns, pod)})
        p["problems"].append({"kind": problem, "detail": detail})

    for r in res["waiting"]:
        m = r["metric"]
        if m.get("reason") in ("ContainerCreating", "PodInitializing"):
            continue
        add(m.get("namespace", ""), m.get("pod", ""), m.get("reason", "Waiting"), m.get("container", ""))
    for r in res["phase"]:
        m = r["metric"]
        add(m.get("namespace", ""), m.get("pod", ""), m.get("phase", ""))
    for r in res["oom"]:
        m = r["metric"]
        add(m.get("namespace", ""), m.get("pod", ""), "OOMKilled", f"{m.get('container', '')} · son kapanış bellek yetmediği için")
    for r in res["restarts"]:
        m = r["metric"]
        n = round(_v(r))
        if n < 1:
            continue
        key = (m.get("namespace", ""), m.get("pod", ""))
        if key in pods:
            pods[key]["restarts_24h"] = n
        else:
            add(*key, "Restart", "")
            pods[key]["restarts_24h"] = n
    pod_list = sorted(pods.values(), key=lambda p: (-len([x for x in p["problems"] if x["kind"] != "Restart"]), -p["restarts_24h"]))

    # ---------------------------------------------------------- iş yükleri
    workloads = []
    for k, kind, label in (("deploy", "Deployment", "deployment"), ("sts", "StatefulSet", "statefulset"), ("ds", "DaemonSet", "daemonset")):
        for r in res[k]:
            m = r["metric"]
            ns, name = m.get("namespace", ""), m.get(label, "")
            workloads.append({"kind": kind, "namespace": ns, "name": name, "missing": int(_v(r)),
                              "cmds": [f"kubectl -n {ns} describe {kind.lower()} {name}", f"kubectl -n {ns} get pods -l app={name} -o wide"]})
    for r in res["hpa_max"]:
        m = r["metric"]
        ns, name = m.get("namespace", ""), m.get("horizontalpodautoscaler", "")
        workloads.append({"kind": "HPA", "namespace": ns, "name": name, "missing": 0, "note": "en fazla pod sayısına dayanmış",
                          "cmds": [f"kubectl -n {ns} describe hpa {name}"]})
    jobs = [{"namespace": r["metric"].get("namespace", ""), "name": r["metric"].get("job_name", ""), "failed": int(_v(r)),
             "cmds": [f"kubectl -n {r['metric'].get('namespace', '')} describe job {r['metric'].get('job_name', '')}"]} for r in res["jobs"]]

    # ---------------------------------------------------------- sertifika / disk
    certs = sorted(({"namespace": r["metric"].get("namespace", ""), "name": r["metric"].get("name", ""), "days": round(_v(r), 1)}
                    for r in res["certs"]), key=lambda c: c["days"])
    pvcs = sorted(({"namespace": r["metric"].get("namespace", ""), "name": r["metric"].get("persistentvolumeclaim", ""), "used": _v(r)}
                   for r in res["pvc"]), key=lambda p: -p["used"])

    # ---------------------------------------------------------- kaynak: ayrılan / kullanılan
    cu, cr, mu, mr = (_by(res[k], "namespace") for k in ("ns_cpu_use", "ns_cpu_req", "ns_mem_use", "ns_mem_req"))
    ns_rows = []
    for ns in sorted(set(cr) | set(mr)):
        if not ns or ns in SYSTEM_NS:
            continue
        ns_rows.append({"namespace": ns, "cpu_used": cu.get(ns, 0), "cpu_requested": cr.get(ns, 0),
                        "mem_used": mu.get(ns, 0), "mem_requested": mr.get(ns, 0)})
    ns_rows.sort(key=lambda r: -(r["cpu_requested"] - r["cpu_used"]))

    problems = len([p for p in pod_list if any(x["kind"] != "Restart" for x in p["problems"])])
    return {
        "fetched_at": int(time.time() * 1000),
        "summary": {
            "nodes": len(nodes), "nodes_ready": sum(1 for n in nodes if n["ready"]),
            "problem_pods": problems, "restarting_pods": sum(1 for p in pod_list if p["restarts_24h"]),
            "workloads": len(workloads), "jobs_failed": len(jobs),
            "certs_soon": sum(1 for c in certs if c["days"] < 21), "pvcs_full": sum(1 for p in pvcs if p["used"] >= 0.8),
        },
        "nodes": nodes, "pods": pod_list[:60], "workloads": workloads, "jobs": jobs[:30],
        "certs": certs, "pvcs": pvcs, "namespaces": ns_rows,
    }
