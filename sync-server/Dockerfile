FROM node:24-slim

WORKDIR /app

# Install lightweight Python + pypdfium2 + Pillow for on-demand single-page PDF rendering
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
  && pip3 install --no-cache-dir --break-system-packages pypdfium2 pillow \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY modules ./modules
COPY shared ./shared
COPY sync-server ./sync-server
COPY mobile-app/www ./mobile-app/www

ENV NODE_ENV=production
ENV PORT=4180
ENV HOST=0.0.0.0
ENV SYNC_DATA_DIR=/data
ENV PYTHON_BIN=python3

VOLUME ["/data"]
EXPOSE 4180

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4180/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "sync-server/server.mjs"]
