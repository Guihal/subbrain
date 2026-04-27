#!/usr/bin/env bash
# Pre-commit guardrails (FILE-SIZE-1).
# Runs file-size + deep-import checks in STRICT mode.
# Set SKIP_GUARDRAILS=1 to bypass (emergency only — re-enables on next commit).
set -e
if [ "${SKIP_GUARDRAILS:-0}" = "1" ]; then
  echo "[pre-commit] SKIP_GUARDRAILS=1 — bypassing guardrails (this is loud on purpose)"
  exit 0
fi
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
STRICT_FILE_RULES=1 bun run scripts/check-file-size.ts
STRICT_FILE_RULES=1 bun run scripts/check-deep-imports.ts
