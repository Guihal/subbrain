#!/usr/bin/env bash
#
# Install the night-cycle cron job on the prod VPS.
#
# Run this ONCE on the VPS as root:
#   bash scripts/install-cron.sh
#
# It appends a daily 00:00 UTC (= 03:00 MSK) entry to root's crontab that
# triggers the night cycle via the Bun container's published port.
# Keep the hour in sync with NIGHT_CYCLE_HOUR_UTC in .env.
#
# /night-cycle is registered before authMiddleware in src/index.ts, so it does
# not require a Bearer token. The container only publishes :4000 on
# 127.0.0.1, so this is reachable from the host but not from the public net.

set -euo pipefail

CRON_LINE='0 0 * * * curl -fsS -X POST http://127.0.0.1:4000/night-cycle -m 600 >> /var/log/subbrain-night-cycle.log 2>&1'
MARKER='# subbrain night-cycle'

current="$(crontab -l 2>/dev/null || true)"

if printf '%s\n' "$current" | grep -qF "$MARKER"; then
  echo "Cron entry already installed. Current crontab:"
  printf '%s\n' "$current" | grep -A1 -F "$MARKER"
  exit 0
fi

{
  printf '%s\n' "$current"
  printf '\n%s\n%s\n' "$MARKER" "$CRON_LINE"
} | crontab -

touch /var/log/subbrain-night-cycle.log
chmod 644 /var/log/subbrain-night-cycle.log

echo "Installed. Entry:"
echo "$CRON_LINE"
echo
echo "Logs: /var/log/subbrain-night-cycle.log"
echo "Manual trigger: curl -X POST http://127.0.0.1:4000/night-cycle"
