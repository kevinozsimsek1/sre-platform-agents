# SRE Portal

Prod'daki alertleri, olayları, deploy'ları, SLO'ları ve nöbet yükünü tek yerden görmek için yaptığımız portal. Veriyi Grafana'dan okuyor, hiçbir şeyi değiştirmiyor. Alertlere tıklayınca nereye bakman gerektiği linkleriyle geliyor, istersen agent'a da araştırtabiliyorsun.

İki parçası var:

- `web/` arayüz (React)
- `api/` arka taraf (Python, FastAPI). Grafana ve Prometheus'tan veriyi o çekiyor.

nginx ikisini tek adreste topluyor, agent sohbetlerini de (`/cloudwatch/`, `/eks/`) aynı yerden açıyor.

## Lazım olanlar

- Docker
- Grafana'ya giriş yapabildiğin bir kullanıcı (kullanıcı adı ve şifre) ya da service account token
- Kodu değiştireceksen Node 22 veya üstü ve Python 3.13

## En kolay yol: Docker ile çalıştırmak

1. Repoyu indir ve klasöre gir.

```bash
git clone https://github.com/kevinozsimsek1/sre-platform-agents.git
cd sre-platform-agents
```

2. İki image'ı build et.

```bash
docker build -t sre-portal .
docker build -t sre-portal-api api
```

3. Çalıştır. Grafana adresini, kullanıcı adını ve şifreni kendi bilgilerinle değiştir, başka bir şey yazmana gerek yok.

```bash
docker network create sre-portal

docker run -d --name portal-api --network sre-portal \
  -e GRAFANA_URL=https://grafana.sirketin.com \
  -e GRAFANA_USER=kullanici_adin \
  -e GRAFANA_PASS=sifren \
  -v sre-portal-data:/data \
  sre-portal-api

docker run -d --name portal-web --network sre-portal -p 8088:80 \
  -e CLOUDWATCH_UPSTREAM=127.0.0.1:9 \
  -e EKS_UPSTREAM=127.0.0.1:9 \
  -e PORTAL_API_UPSTREAM=portal-api:8000 \
  sre-portal
```

4. Tarayıcıda http://localhost:8088 adresini aç. İlk açılışta veri 15-20 saniye kadar yüklenir, sonra hızlanır.

Agent'lar lokalde olmadığı için agent kartları "kapalı" görünür, bu normal. Agent'ları da görmek istersen cluster'daki gateway'e port-forward ile bağlan (aşağıda var).

Kapatmak için:

```bash
docker rm -f portal-api portal-web
```

## Kodu değiştireceksen: geliştirme modu

Burada her şey kaydettiğin anda yenileniyor, tekrar build almana gerek yok.

API'yi başlat:

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
GRAFANA_URL=https://grafana.sirketin.com GRAFANA_USER=kullanici_adin GRAFANA_PASS=sifren DATA_DIR=./data \
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Başka bir terminalde arayüzü başlat:

```bash
cd web
npm ci
npm run dev
```

Sonra http://localhost:5173/_portal/ adresini aç.

## Ayarlar

API'nin okuduğu ortam değişkenleri:

| Değişken | Ne işe yarıyor |
|---|---|
| `GRAFANA_URL` | Grafana adresi |
| `GRAFANA_USER` / `GRAFANA_PASS` | Grafana kullanıcısı. Token varsa onun yerine `GRAFANA_TOKEN` kullan |
| `GRAFANA_ORGS` | Alert kurallarının olduğu org'lar, varsayılan `3,1` |
| `PROM_DS_UID` | SLO hesabı için Prometheus datasource UID'i. Boş bırakırsan portal Grafana'dan kendisi bulur (adında "prod" geçeni seçer) |
| `TEMPO_DS_UID` | Trace linkleri için Tempo datasource UID'i. Boş bırakırsan kendisi bulur |
| `AWS_PROD_ACCOUNT` | AWS linklerinin yanında gösterilen hesap numarası (zorunlu değil) |
| `ADMIN_PASSWORD_HASH` | Denetim kaydı ekranının şifresi (aşağıya bak) |
| `DATA_DIR` | Agent analizlerinin ve denetim kaydının yazıldığı klasör |
| `AGENTS_JSON` | Agent listesi. Yeni bir agent eklemek için buraya eklemen yeterli |

GPU maliyeti kısmı için API'nin AWS'ye okuma yetkisiyle bağlanabilmesi lazım. Lokalde AWS profilini vermek için API container'ına şunları ekle:

```bash
-e AWS_PROFILE=profil_adin -e HOME=/home/portal -v $HOME/.aws:/home/portal/.aws:ro
```

## Servis hedefleri (SLO)

Her servisin hedefi `api/slo-targets.toml` dosyasında. Hedefi servisin sahibi ekip belirler. Dosyada olmayan servislerde `[default]` kullanılır. Portal her servis için geçmiş performansına göre bir hedef de önerir, servis detay sayfasında dosyaya eklenecek satırlar hazır gelir.

Örnek:

```toml
[services."plt-comm-workflow-manager"]
latency_ms = 5000
latency_target = 95.0
owner = "Platform ekibi"
note = "İş akışları uzun sürüyor, kullanıcı arka planda bekliyor."
```

Dosyayı değiştirdikten sonra API image'ını yeniden build edip deploy etmek yeterli.

## Denetim kaydı şifresi

Denetim kaydı ekranı sadece admin içindir. Kullanıcı adı `root`. Şifreyi düz yazmıyoruz, hash'ini veriyoruz. Hash'i şöyle üretirsin:

```bash
cd api
read -s "PW?Şifre: " && echo
ADMIN_PW="$PW" .venv/bin/python -c "import os;from app.audit import make_hash;print(make_hash(os.environ['ADMIN_PW']))"
unset PW
```

Çıkan değeri `ADMIN_PASSWORD_HASH` olarak ver. Bash kullanıyorsan ilk satırı `read -s -p "Şifre: " PW && echo` diye yaz.

## Cluster'a deploy

Önce proje klasöründe (README'nin olduğu yerde) `deploy.env` dosyasını oluştur ve içini doldur. Bu dosya git'e gitmez.

```bash
cp deploy.env.example deploy.env
```

Image'ları amd64 için build edip ECR'a gönder:

```bash
set -o pipefail
set -a; source deploy.env; set +a
aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin $ECR_REGISTRY
docker buildx build --platform linux/amd64 -t $ECR_REGISTRY/agent-gateway:latest --push .
docker buildx build --platform linux/amd64 -t $ECR_REGISTRY/sre-portal-api:latest --push api
```

Secret'lar cluster'da olmalı: `sre-portal-grafana` (GRAFANA_URL, GRAFANA_USER, GRAFANA_PASS) ve `sre-portal-admin` (ADMIN_USER, ADMIN_PASSWORD_HASH).

Sonra manifesti uygula:

```bash
envsubst '$ECR_REGISTRY $PROM_DS_UID $TEMPO_DS_UID $AWS_PROD_ACCOUNT' < k8s.yaml | kubectl apply -f -
kubectl rollout restart deploy/agent-gateway -n mcp-llm-agent
```

Portala girmek için:

```bash
kubectl port-forward -n mcp-llm-agent svc/agent-gateway 8080:80
```

ve http://localhost:8080 adresini aç.

## Bilmen gerekenler

- Portal Grafana'ya sadece okuma isteği atıyor, hiçbir alert'i ya da dashboard'u değiştiremez.
- Agent analizleri ve denetim kaydı pod'un geçici diskinde duruyor. Pod yeniden başlarsa silinir.
- Agent'lar GPU node açıkken çalışıyor. Lokalde GPU kapalıyken sadece "Agent ile araştır" hata verir, gerisi çalışır. Cluster'da ise portal da aynı node üzerinde olduğu için GPU kapalıyken portal da kapalıdır.
