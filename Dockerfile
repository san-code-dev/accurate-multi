# MCP server Accurate multi-tenant (baca + tulis tambah/ubah), mode HTTP, dengan halaman admin.
# Kredensial TIDAK dimasukkan ke image: tenant & audit disimpan di folder data/ yang dipasang saat container jalan.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js accurate-client.js guard.js fetch-all.js tenants.js audit.js admin.js ./
COPY admin ./admin

# Di dalam container server harus mendengar di semua antarmuka agar bisa dijangkau lewat port yang dipetakan.
ENV HOST=0.0.0.0 PORT=3031 ADMIN_HOST=0.0.0.0 ADMIN_PORT=3032 \
    TENANTS_FILE=/app/data/tenants.json AUDIT_FILE=/app/data/audit.log
EXPOSE 3031 3032

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

CMD ["node", "server.js"]
