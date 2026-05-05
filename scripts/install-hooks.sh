#!/usr/bin/env bash
# Install lefthook hooks (gate pyramid: CP0 pre-commit, CP1-CP3 pre-push).
# Idempotent — re-running reinstalls.
set -e
bunx lefthook install
echo "[install-hooks] lefthook hooks installed"
echo "[install-hooks] bypass with SKIP_GUARDRAILS=1 git commit ... (emergency only)"
