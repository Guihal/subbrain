#!/usr/bin/env bash
# Install repo guardrail hooks (FILE-SIZE-1).
# Idempotent — re-running overwrites the existing pre-commit hook.
set -e
ROOT="$(git rev-parse --show-toplevel)"
HOOK="$ROOT/.git/hooks/pre-commit"
cp "$ROOT/scripts/pre-commit.sh" "$HOOK"
chmod +x "$HOOK"
echo "[install-hooks] installed $HOOK"
echo "[install-hooks] bypass with SKIP_GUARDRAILS=1 git commit ... (emergency only)"
