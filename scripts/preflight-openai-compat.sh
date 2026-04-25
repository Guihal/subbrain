#!/usr/bin/env bash
set -euo pipefail
VPS_HOST="${VPS_HOST:-root@109.120.187.244}"
AUTH_PATH="${AUTH_PATH:-/root/.codex/auth.json}"
ssh "$VPS_HOST" "
  if [ ! -f '$AUTH_PATH' ]; then echo 'MISSING: $AUTH_PATH — run codex login on VPS first' >&2; exit 1; fi
  PERMS=\$(stat -c %a '$AUTH_PATH')
  if [ \"\$PERMS\" != '600' ]; then echo \"WRONG PERMS: \$PERMS (expected 600)\" >&2; exit 1; fi
  echo 'OK: auth.json present, perms 600'
"
