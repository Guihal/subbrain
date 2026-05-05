#!/usr/bin/env bash
# Pre-commit guardrails (KIMI-RAILS-1).
# Runs ALL checks in STRICT mode — kimi и я физически не закоммитим говно.
# Set SKIP_GUARDRAILS=1 to bypass (emergency only — re-enables on next commit, screams loudly).
set -e

if [ "${SKIP_GUARDRAILS:-0}" = "1" ]; then
  echo "[pre-commit] !!! SKIP_GUARDRAILS=1 !!! bypassing ALL guardrails"
  echo "[pre-commit] this should NEVER happen unprompted. log: $(date -Iseconds)" >&2
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "${YELLOW}▶ $1${NC}"; }
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; }

step "1/6  file-size cap (150 LOC)"
STRICT_FILE_RULES=1 bun run scripts/check-file-size.ts || { fail "file-size"; exit 1; }
ok "file-size"

step "2/6  deep-import ban"
STRICT_FILE_RULES=1 bun run scripts/check-deep-imports.ts || { fail "deep-imports"; exit 1; }
ok "deep-imports"

step "3/6  forbidden patterns (as any, @ts-ignore, emoji, raw fetch, ...)"
STRICT_FILE_RULES=1 bun run scripts/check-forbidden-patterns.ts || { fail "forbidden-patterns"; exit 1; }
ok "forbidden-patterns"

step "4/6  biome (lint + format strict)"
bunx biome check --error-on-warnings . || { fail "biome — run: bun run format && bun run lint:fix"; exit 1; }
ok "biome"

step "5/6  tsc --noEmit (strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes)"
bunx tsc --noEmit -p tsconfig.json || { fail "tsc"; exit 1; }
ok "tsc"

step "6/6  bun test (unit only — *.live.ts skipped)"
bun test --bail tests/ 2>/dev/null || bun test --bail 2>/dev/null || { fail "tests"; exit 1; }
ok "tests"

echo ""
ok "all 6 guardrails passed — commit allowed"
