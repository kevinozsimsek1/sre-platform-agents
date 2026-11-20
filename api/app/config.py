"""Portal ayarları. Hepsi ortam değişkeninden okunur; varsayılanlar Nebim ortamına göredir."""
import json
import os


def _env(name: str, default: str) -> str:
    return os.getenv(name, default)


GRAFANA_URL = _env("GRAFANA_URL", "").rstrip("/")  # ör. https://grafana.example.com
GRAFANA_TOKEN = os.getenv("GRAFANA_TOKEN")  # service account token varsa onu kullan
GRAFANA_USER = os.getenv("GRAFANA_USER")
GRAFANA_PASS = os.getenv("GRAFANA_PASS")
# Alert kurallarının bulunduğu org'lar. İlki ana org (OPS) kabul edilir.
GRAFANA_ORGS = [int(x) for x in _env("GRAFANA_ORGS", "3,1").split(",") if x.strip()]
PROM_DS_UID = _env("PROM_DS_UID", "")    # SLO için kullanılan Prometheus datasource UID'i
TEMPO_DS_UID = _env("TEMPO_DS_UID", "")  # "Nereden bakılır" trace linkleri için (isteğe bağlı)
# Sadece prod: kuralın kullandığı bütün veri kaynaklarının adı buna uymalı. Boş bırakılırsa filtre kapanır.
PROD_DS_PATTERN = _env("PROD_DS_PATTERN", "prod")
# Kural adında bunlardan biri geçiyorsa prod sayılmaz (ör. "Pod Not Running - dev")
NONPROD_TITLE_PATTERN = _env("NONPROD_TITLE_PATTERN", r"\b(dev|qa|uat|test|stag(e|ing)|bm)\b")
AWS_PROD_ACCOUNT = _env("AWS_PROD_ACCOUNT", "")  # AWS linklerinde gösterilen hesap (isteğe bağlı)
PROM_ORG = int(_env("PROM_ORG", "3"))

WINDOW_DAYS = int(_env("WINDOW_DAYS", "30"))
TZ_OFFSET_HOURS = int(_env("TZ_OFFSET_HOURS", "3"))  # İstanbul
WORK_START, WORK_END = int(_env("WORK_START", "8")), int(_env("WORK_END", "19"))
NIGHT_END = int(_env("NIGHT_END", "7"))  # 00:00–07:00 "gece" sayılır
INCIDENT_GAP_MIN = int(_env("INCIDENT_GAP_MIN", "5"))

SLO_AVAILABILITY = float(_env("SLO_AVAILABILITY", "0.999"))
SLO_LATENCY = float(_env("SLO_LATENCY", "0.99"))
SLO_LATENCY_LE = _env("SLO_LATENCY_LE", "0.5")  # histogram bucket sınırı (saniye)
SLO_MIN_REQUESTS = int(_env("SLO_MIN_REQUESTS", "1000"))
SLO_EXCLUDE_ROUTES = _env("SLO_EXCLUDE_ROUTES", "(?i).*(health|ready|live|metrics|swagger|favicon).*")

GPU_CLUSTER = _env("GPU_CLUSTER", "llm-server")
AWS_REGION = _env("AWS_REGION", "eu-central-1")
# Olayların atanabileceği ekip (virgülle ayrılmış isimler). Boşsa atama kapalı.
SRE_TEAM = [x.strip() for x in _env("SRE_TEAM", "").split(",") if x.strip()]
# Servis loglarının CloudWatch'taki yeri: bu önekle başlayıp servis adıyla biten log grubu aranır
LOG_GROUP_PREFIX = _env("LOG_GROUP_PREFIX", "/aws/containerinsights/")
GPU_PRICES = json.loads(_env("GPU_PRICES_USD", '{"g6.xlarge": 1.0064}'))

# CloudWatch fiyatları (eu-central-1, on-demand). Fiyat değişirse ortam değişkeniyle güncellenir.
CW_METRIC_USD_PER_1K = float(_env("CW_METRIC_USD_PER_1K", "0.01"))   # GetMetricData, 1000 metrik
CW_LOGS_USD_PER_GB = float(_env("CW_LOGS_USD_PER_GB", "0.0063"))     # Logs Insights, taranan GB
# Gerçek faturayı okumak için kullanılan AWS profili (Cost Explorer, prod hesabı).
# Boşsa varsayılan oturum kullanılır. Cluster'da IRSA ile verilir; yalnızca ce:GetCostAndUsage gerekir.
COST_AWS_PROFILE = _env("COST_AWS_PROFILE", "")
# Atıl kaynak taraması birden çok hesapta çalışır: israf ana hesapta değil, kimsenin
# bakmadığı hesap-bölge çiftinde birikir. Biçim: "etiket=profil" çiftleri, virgülle ayrılmış.
# Boş bırakılırsa yalnızca COST_AWS_PROFILE taranır. Cluster'da profil yerine IRSA kullanılır.
IDLE_AWS_ACCOUNTS = _env("IDLE_AWS_ACCOUNTS", "")
# Log fiyatları: gerçek fatura okunabiliyorsa oradan türetilir, bunlar yalnızca yedek.
LOGS_INGEST_USD_PER_GB = float(_env("LOGS_INGEST_USD_PER_GB", "0.63"))
LOGS_STORAGE_USD_PER_GB = float(_env("LOGS_STORAGE_USD_PER_GB", "0.0324"))

# Agent kayıt defteri. Yeni bir MCP agent'ı eklemek için AGENTS_JSON'a bir kayıt eklemek yeter:
#   url: agent'ın POST /chat ucu olan servis adresi
#   handles: bu agent'ın uygun olduğu sinyaller. Kural sorgusunda/etiketlerinde bunlardan biri geçerse önerilir.
#   payload: (isteğe bağlı) /chat gövdesine eklenecek sabit alanlar
AGENT_REGISTRY = json.loads(_env("AGENTS_JSON", json.dumps({
    "cloudwatch": {
        "label": "CloudWatch agent", "url": "http://cloudwatch-agent.mcp-llm-agent.svc.cluster.local:80",
        "description": "CloudWatch metrikleri, Logs Insights, alarmlar",
        "handles": ["cloudwatch", "AWS/", "logs", "lambda", "rds", "applicationelb", "sqs", "apigateway", "kafka"],
    },
    "eks": {
        "label": "EKS agent", "url": "http://eks-agent.mcp-llm-agent.svc.cluster.local:8080",
        "description": "Kubernetes: pod, node, deployment, event",
        "handles": ["kube_", "pod", "namespace", "container", "node_", "deployment", "crashloop", "imagepull"],
    },
})))
AGENTS = {k: v["url"] for k, v in AGENT_REGISTRY.items()}
DEFAULT_AGENT = _env("DEFAULT_AGENT", "cloudwatch")
DATA_DIR = _env("DATA_DIR", "/data")
CACHE_TTL = int(_env("CACHE_TTL", "300"))
