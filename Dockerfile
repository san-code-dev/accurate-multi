# MCP server Accurate multi-tenant (read-only), mode HTTP.
# Kredensial TIDAK dimasukkan ke image: daftar tenant dipasang dari folder config/ saat container jalan (lihat docker-compose.yml).
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js accurate-client.js readonly-guard.js fetch-all.js tenants.js ./

# Di dalam container server harus mendengar di semua antarmuka agar bisa dijangkau lewat port yang dipetakan.
ENV HOST=0.0.0.0 PORT=3031 TENANTS_FILE=/app/config/tenants.json
EXPOSE 3031

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

CMD ["node", "server.js"]
