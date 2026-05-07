# ─── Build stage ──────────────────────────────────────────
FROM oven/bun:1.3 AS builder

WORKDIR /app

# Install deps first (cache layer)
COPY package.json bun.lock* ./
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY packages/plugin/package.json packages/plugin/
COPY packages/agent/package.json packages/agent/
COPY packages/server/package.json packages/server/
COPY web/package.json web/
RUN bun install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY public/ public/
COPY scripts/ scripts/
COPY tsconfig.json ./

# Bun 1.3 doesn't create node_modules/@subbrain/* workspace symlinks
# during `bun install --frozen-lockfile`. Create manually so workspace
# imports (e.g. `@subbrain/agent/plugins-internal`) resolve at runtime.
RUN mkdir -p node_modules/@subbrain && \
    ln -sfn /app/packages/agent     node_modules/@subbrain/agent && \
    ln -sfn /app/packages/core      node_modules/@subbrain/core && \
    ln -sfn /app/packages/providers node_modules/@subbrain/providers && \
    ln -sfn /app/packages/plugin    node_modules/@subbrain/plugin && \
    ln -sfn /app/packages/server    node_modules/@subbrain/server

# ─── Runtime stage ────────────────────────────────────────
FROM oven/bun:1.3-slim

WORKDIR /app

# sqlite-vec + Chrome system deps.
# @playwright/mcp pins to the Chrome *channel* (not Chromium), so we install
# Google Chrome below via `playwright install chrome`. The apt packages here
# satisfy its shared-library dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 \
    wget ca-certificates gnupg \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    fonts-liberation libu2f-udev libvulkan1 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./

# Install Google Chrome (required by @playwright/mcp — it pins to the
# "chrome" channel, not Chromium). Installs into /opt/google/chrome/chrome.
RUN bunx playwright install chrome --with-deps

# DB lives in /data (mounted as volume — NEVER baked into image)
# Logs live in /data/logs
RUN mkdir -p /data/logs

ENV NODE_ENV=production
ENV DB_PATH=/data/subbrain.db
ENV LOG_DIR=/data/logs

EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://localhost:4000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "run", "packages/server/src/index.ts"]
