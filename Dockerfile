# ─── Build stage ──────────────────────────────────────────
FROM oven/bun:1.3 AS builder

WORKDIR /app

# Install deps first (cache layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY src/ src/
COPY public/ public/
COPY scripts/ scripts/
COPY tsconfig.json ./

# ─── Runtime stage ────────────────────────────────────────
FROM oven/bun:1.3-slim

WORKDIR /app

# sqlite-vec needs these
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./

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

CMD ["bun", "run", "src/index.ts"]
