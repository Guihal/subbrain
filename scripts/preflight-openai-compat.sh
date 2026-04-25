#!/usr/bin/env bash
# Preflight for openai-compat (CLIProxyAPI sidecar) deployment.
# Verifies VPS has the cliproxy auth dir + config + ChatGPT Pro OAuth.
set -euo pipefail
VPS_HOST="${VPS_HOST:-root@109.120.187.244}"
SUBBRAIN_DIR="${SUBBRAIN_DIR:-/opt/subbrain}"

ssh "$VPS_HOST" "
  cd '$SUBBRAIN_DIR'
  if [ ! -f cliproxy/config.yaml ]; then
    echo 'MISSING: cliproxy/config.yaml — copy cliproxy/config.example.yaml first' >&2
    exit 1
  fi
  if ! ls cliproxy/auths/*.json >/dev/null 2>&1; then
    echo 'MISSING: cliproxy/auths/*.json — run \`docker compose exec cliproxy ./cli-proxy-api --codex-login --no-browser\`' >&2
    exit 1
  fi
  echo 'OK: cliproxy/config.yaml + cliproxy/auths/*.json present'
"
