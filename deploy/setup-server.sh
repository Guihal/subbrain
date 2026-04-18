#!/usr/bin/env bash
#
# First-time server setup for Subbrain.
# Run once on a fresh server as root.
#
# Usage: curl -sSL <raw-github-url>/deploy/setup-server.sh | bash -s -- <domain>
#   or:  bash deploy/setup-server.sh brain.example.com
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

# ─── 3. Caddy config ─────────────────────────────────────
echo "→ Configuring Caddy for ${DOMAIN}..."
mkdir -p /var/log/caddy

if [ -f "${APP_DIR}/deploy/Caddyfile" ]; then
  sed "s/{domain}/${DOMAIN}/g" "${APP_DIR}/deploy/Caddyfile" > /etc/caddy/Caddyfile
else
  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy localhost:4000
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
    }
    log {
        output file /var/log/caddy/subbrain.log
        format json
    }
}
EOF
fi

systemctl enable --now caddy
systemctl reload caddy

# ─── 4. App directory ────────────────────────────────────
mkdir -p "${APP_DIR}"

# ─── 5. .env template ────────────────────────────────────
if [ ! -f "${APP_DIR}/.env" ]; then
  echo "→ Creating .env template..."
  cat > "${APP_DIR}/.env" <<'EOF'
# === Subbrain config ===
PROXY_AUTH_TOKEN=subbrain-local-dev
PROXY_PORT=4000
DB_PATH=/data/subbrain.db

# === LLM Providers ===
NVIDIA_API_KEY=
OPENROUTER_API_KEY=

# === Telegram (fill when ready) ===
# TG_API_ID=
# TG_API_HASH=
# TG_BOT_TOKEN=
# TG_OWNER_CHAT_ID=
# TG_MTPROTO_SERVER=
# TG_MTPROTO_PORT=
# TG_MTPROTO_SECRET=
EOF
  echo ""
  echo "⚠️  IMPORTANT: Edit ${APP_DIR}/.env with real values before deploying!"
  echo ""
fi

# ─── 6. Firewall ─────────────────────────────────────────
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
echo "  2. Set up GitHub repo secrets:"
echo "     - SERVER_HOST = $(curl -4s ifconfig.me 2>/dev/null || echo '<server-ip>')"
echo "     - SERVER_USER = $(whoami)"
echo "     - SERVER_SSH_KEY = <your private SSH key>"
echo "  3. Push to main → CI/CD will deploy automatically"
echo ""
echo "  Or manual deploy:"
echo "     cd ${APP_DIR} && git pull && docker compose up -d --build"
