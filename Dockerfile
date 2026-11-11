# 1) Portal arayüzünü (React + Vite + Tailwind) derle
FROM node:26.13.0-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 2) nginx: portalı sunar, agent'lara proxy yapar
FROM nginx:1.30.6-alpine

# nginx:alpine, /etc/nginx/templates altındaki *.template dosyalarını
# başlangıçta ortam değişkenleriyle doldurup conf.d içine yazar.
COPY templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web /web/dist /usr/share/nginx/html/_portal

EXPOSE 80
