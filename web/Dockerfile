# ─── Build stage ──────────────────────────────────────────
FROM oven/bun:1.3 AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ─── Runtime stage ────────────────────────────────────────
FROM oven/bun:1.3-slim

WORKDIR /app

COPY --from=builder /app/.output ./.output

ENV NODE_ENV=production
ENV NITRO_PORT=3000
ENV NITRO_HOST=0.0.0.0
# API на соседнем контейнере (через docker network)
ENV NUXT_PUBLIC_API_BASE=

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://localhost:3000/').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", ".output/server/index.mjs"]
