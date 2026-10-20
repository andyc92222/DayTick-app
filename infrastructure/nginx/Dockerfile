FROM nginx:1.28-alpine
COPY infrastructure/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY infrastructure/nginx/proxy_params /etc/nginx/proxy_params
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/health/live || exit 1
