#!/usr/bin/env bash
#
# First-time server setup for Subbrain.
# Run once on a fresh server as root.
#
# Usage: bash deploy/setup-server.sh <domain>
#
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain>}"
APP_DIR="/opt/subbrain"

echo "=== Subbrain server setup for ${DOMAIN} ==="

# ─── 1. Docker ────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "→ Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

# ─── 2. Caddy ────────────────────────────────────────────
if ! command -v caddy &>/dev/null; then
  echo "→ Installing Caddy..."
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# ─── 3. App directory ────────────────────────────────────
mkdir -p "${APP_DIR}"

# ─── 4. .env template ────────────────────────────────────
if [ ! -f "${APP_DIR}/.env" ]; then
  echo "→ Creating .env template..."
  cat > "${APP_DIR}/.env" <<'EOF'
# === Subbrain config ===
PROXY_AUTH_TOKEN=
PROXY_PORT=4000
DB_PATH=/data/subbrain.db
LOG_DIR=/data/logs

# === LLM Providers ===
NVIDIA_API_KEY=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# === Telegram ===
TG_API_ID=
TG_API_HASH=
TG_BOT_TOKEN=
TG_OWNER_CHAT_ID=
TG_POLLING=true
TG_SESSION=
TG_TUNNEL_HOST=
TG_TUNNEL_BASE_PORT=19150
TG_API_ROOT=
TG_API_PROXY_KEY=
EOF
  echo ""
  echo "⚠️  IMPORTANT: Edit ${APP_DIR}/.env with real values before deploying!"
  echo ""
fi

# ─── 5. Firewall ─────────────────────────────────────────
if command -v ufw &>/dev/null; then
  echo "→ Configuring firewall..."
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 22/tcp
  ufw --force enable
fi

echo ""
echo "✅ Server ready!"
echo ""
echo "Next steps:"
echo "  1. Edit ${APP_DIR}/.env with real API keys"
echo "  2. Update GitHub repo secrets:"
echo "     - SERVER_HOST = $(curl -4s ifconfig.me 2>/dev/null || echo '<server-ip>')"
echo "     - SERVER_USER = root"
echo "     - SERVER_SSH_KEY = <subbrain_deploy private key>"
echo "     - CADDY_AUTH_HASH = <output of: caddy hash-password --plaintext YOUR_PASSWORD>"
echo "  3. Push to main → CI/CD will deploy automatically"
echo ""
