# Agent-teams task 08e — Phase 8e: Telegram PII gates + per-chat ingest policy

**Status:** open contract (Wave 4 security-tier; can start after Phase 1 Bifrost has landed feature-flag, but does not block on it).
**Worker model:** Kimi K2.6 (per packet). Two packets escalate: 8e-3 (`schema`) and 8e-4 (`db`) — Kimi must FAIL fast on those with `requires_strong_model`.
**Risk:** mixed — packet-by-packet (one schema, one db migration, four security/public-api).
**Source spec:**
- `docs/specs/subbrain-main.md` line 643 (Risk Register, HIGH: PII exposure from Telegram/raw logs).
- `docs/specs/subbrain-main.md` line 741 (Phase 8e — ingest-time scrub, per-chat policy).
- `docs/specs/subbrain-main.md` lines 244-246 (per-chat privacy/PII controls need UI and strict defaults).

## Phase 8e goal (verbatim from spec)

Move PII scrub from night-cycle (post-fact, hours after ingest) to ingest-time
so plaintext PII never lands in `tg_messages.text` or in any backup. Add
per-chat policy with strict default (`metadata_only`). Defense-in-depth:
night-cycle scrub stays installed and continues to run — it becomes a rare /
empty pass once ingest-time scrub is in place.

## Threat model recap

1. **Database file leak** (laptop theft, prod-disk exfil, accidental
   `--delete`-less rsync of `data/subbrain.db` to a third party). With raw
   `tg_messages.text` storage today, every leaked DB is a leak of plaintext
   chat history including emails, phones, addresses, payment data, etc.
2. **Backup leak** — Phase 8c backup ships SQLite dump off-host. Without
   ingest-time scrub, that backup is plaintext PII.
3. **MCP tool leakage** — `tg_search_messages` and `tg_read_chat` return
   `tg_messages.text` to whatever agent calls them. Today an autonomous /
   free-agent loop can read arbitrary PII.

Phase 8e closes (1) and (2) by writing scrubbed text only. (3) is closed by
search/read tools operating on the same scrubbed text.

## Hard non-goals (apply to every packet below — do not restate per packet)

1. **No automatic UI for policy management.** Policy is set via MCP tool
   (`tg_set_chat_policy`) and via direct DB row in this phase. UI is
   deferred to Phase 7 (per spec line 246).
2. **No encrypted blob of original plaintext.** v1 drops the original after
   scrub. Recovery path = re-fetch from Telegram via userbot (`scripts/tg-reindex.ts`).
3. **No new tracking of which user said which PII token.** No identity
   surfaces, no per-sender PII counter, no "this user said an email" record.
   The whole point is to forget that information.
4. **No PII scrub for autobot's own outbound messages.** `tg_send_message`
   output is model-generated; if it leaks PII it is an upstream prompt-leak
   issue and is governed by Phase 8a approval flow, not this phase.
5. **Do not disable the existing night-cycle PII scrub step** (`src/pipeline/night-cycle/steps/scrub.ts`).
   It stays for defense-in-depth (e.g. legacy rows, future ingest paths).
6. **No new tracking of message author identity beyond what `tg_messages.from_name`
   already stores.** The spec already accepts that `from_name` is plaintext.
7. **No frontend changes in this phase.** No edits under `web/app/`.
8. **No new model roles.** No edits to `src/lib/model-map.ts`.
9. **No changes to `tg_send_message`, `tg_list_chats` shape, or any other
   telegram tool besides the ones explicitly named in 8e-5.**
10. **No backup-format changes.** That is Phase 8c.

## Glossary (project-specific)

- **Ingest** — the moment a message row is inserted into `tg_messages`.
  Today's ingest paths: `scripts/tg-reindex.ts` (backfill) and any code
  that calls `MemoryDB.insertTgMessage` / `insertTgMessages` (currently
  the reindex script and a future poller). The userbot live monitor
  (`src/telegram/userbot/monitor.ts`) writes to `layer4_log` via
  `appendLog`, NOT to `tg_messages`. Layer 4 is out of scope for this
  phase.
- **Policy** — a string column on `tg_chats` (new) that determines what
  happens at ingest. Values: `ingest`, `ingest_scrubbed`, `metadata_only`,
  `exclude`.
  - `ingest` — store text as-is (no scrub). Reserved for chats explicitly
    marked safe by operator (e.g. self-notes).
  - `ingest_scrubbed` — run `scrubPII`, store the scrubbed result.
  - `metadata_only` — store the row with `text=''` and the original
    sender + timestamp, but no body. Default for new chats.
  - `exclude` — drop the message entirely; do not insert. Equivalent to
    today's `tg_excluded_chats` semantics.
- **Scrub primitive** — `scrubPII(text)` in `src/lib/pii-scrub.ts`. Must
  be a pure function (no DB, no network) and synchronous. v1 implementation
  = local regex set (no LLM call). LLM-based fallback is **out of scope** —
  the night-cycle step keeps the LLM scrub for defense-in-depth.
- **`tg_chats` table** — new in 8e-3. Distinct from existing
  `tg_excluded_chats` (which becomes a backwards-compat read-view, see
  8e-3 migration plan). This is the canonical chat-policy table going
  forward.
- **Backfill** — the one-shot 8e-4 script that re-scrubs every existing
  `tg_messages` row. Idempotent (skips if `pii_scrubbed_at` is set).

## Schema decision (locked before packet 8e-3)

A separate `tg_chat_policy` table is rejected. The existing `tg_excluded_chats`
table is renamed/extended into `tg_chats` (one row per known chat, policy
column included). Migration plan in 8e-3.

Why a single table: (a) avoids JOIN on every ingest, (b) avoids two
sources of truth for "is this chat excluded", (c) makes the back-compat
shim trivial (a SQL view named `tg_excluded_chats` over `tg_chats WHERE
policy='exclude'`).

## PII model decision

`<PII_MODEL>` is set to **regex-only** for v1. Rationale:

- `nvidia/gliner-pii` was floated in the spec source, but as of
  2026-05-05 it is **not verified live on NIM free-tier** in this repo
  (no entry in `src/lib/model-map.ts`, no provider call site). Adding a
  new NIM-hosted model with its own latency budget on the hot ingest
  path = scope creep.
- A regex set is cheap, pure-function, deterministic, testable, and runs
  in microseconds. Acceptable false-negative rate is buffered by the
  night-cycle LLM scrub (defense-in-depth, non-goal #5).
- If a future phase decides to swap regex for an LLM/NER model, the
  contract `scrubPII(text) → { scrubbed, redacted_count, types[] }`
  stays — only the body changes.

## Packet layout (7 packets)

```
8e-1  →  8e-2  →  8e-3  →  8e-4  →  8e-5  →  8e-6  →  8e-7
prim     hook    schema   backfill  MCP     search    tests
```

Sequential. Each merges as one PR. Single packet ≤ 300 LOC, ≤ 4 files.
8e-3 and 8e-4 escalate (Kimi must FAIL with `requires_strong_model`).

---

## 8e-1 — PII scrub primitive (`scrubPII`)

```json
{
  "task_id": "8e-1",
  "goal": "Add pure synchronous function scrubPII(text:string) in src/lib/pii-scrub.ts that returns {scrubbed, redacted_count, types[]} after replacing email, phone, IBAN, credit-card, Russian passport (DDDD DDDDDD), Russian INN (10 or 12 digits), street-address line, and IPv4 with token [REDACTED:<type>]. No barrel re-export needed — repo does not use src/lib/index.ts.",
  "non_goals": [
    "Do not call any network or LLM from scrubPII.",
    "Do not import bun:sqlite or any DB module from src/lib/pii-scrub.ts.",
    "Do not edit any file outside src/lib/pii-scrub.ts and tests/pii-scrub.test.ts.",
    "Do not add a class — single exported function plus a single exported PiiType union type.",
    "Do not redact the literal token 'REDACTED' itself nor a previously-emitted [REDACTED:*] marker (idempotency)."
  ],
  "allowed_write_paths": [
    "src/lib/pii-scrub.ts",
    "tests/pii-scrub.test.ts"
  ],
  "read_context": [
    "src/lib/fts-utils.ts",
    "docs/tasks/agent-teams/08e-telegram-pii.md"
  ],
  "risk_tier": "security",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/pii-scrub.test.ts",
    "bun -e \"import {scrubPII} from './src/lib/pii-scrub'; const r = scrubPII('call me at +7 901 555 0101 or a@b.com'); if (r.redacted_count !== 2) process.exit(1); if (!r.scrubbed.includes('[REDACTED:phone]')) process.exit(1); if (!r.scrubbed.includes('[REDACTED:email]')) process.exit(1);\""
  ],
  "diff_budget_loc": 220,
  "file_count_max": 2,
  "rollback": "git revert the single PR; no data migration required because no DB rows depend on this primitive yet.",
  "whitelist_add": "src/lib/pii-scrub.ts → 220 (new pure-function module, no split candidate)",
  "escalation_triggers": [
    "Spec demands regex coverage for a class not in the explicit list (email/phone/IBAN/credit-card/RU-passport/RU-INN/street/IPv4).",
    "Acceptance command fails because runtime is not Bun.",
    "Same regex pattern matches a non-PII token in a way that requires architectural change to the contract."
  ],
  "glossary": {
    "PiiType": "Union literal type: 'email' | 'phone' | 'iban' | 'card' | 'passport_ru' | 'inn_ru' | 'address' | 'ipv4'.",
    "redacted_count": "Number of substitutions performed; equals types.length only when each type appeared exactly once."
  }
}
```

---

## 8e-2 — Ingest hook: scrub before insert

```json
{
  "task_id": "8e-2",
  "goal": "Add unconditional scrub to TgMessagesTable.insert in src/db/tables/tg-messages.ts so that text is replaced by scrubPII(text).scrubbed before SQL execution. insertMany delegates to insert. Add a pure helper `applyAtIngest(row)` in src/services/tg-ingest.ts that callers (scripts/tg-reindex.ts) invoke before passing rows to the repository; this helper scrubs text and will later (8e-5) read chat policy from tg_chats. pii_scrubbed_at column does not exist yet (8e-3), so do not reference it.",
  "non_goals": [
    "Do not edit src/db/schema.ts in this packet (column add lives in 8e-3).",
    "Do not edit src/repositories/telegram.repo.ts beyond adding a typed pass-through.",
    "Do not change the wire shape of TgMessageInsert.",
    "Do not skip insert for empty scrubbed text — empty body is still a row (timestamp + sender are useful).",
    "Do not import src/services/tg-ingest.ts from src/db/tables/tg-messages.ts (Data→Logic import violates SoC §1a). Table layer scrubs unconditionally; policy-aware routing lives in service layer only."
  ],
  "allowed_write_paths": [
    "src/services/tg-ingest.ts",
    "src/db/tables/tg-messages.ts",
    "scripts/tg-reindex.ts",
    "tests/tg-ingest.test.ts"
  ],
  "read_context": [
    "src/db/tables/tg-messages.ts",
    "src/repositories/telegram.repo.ts",
    "scripts/tg-reindex.ts",
    "src/lib/pii-scrub.ts"
  ],
  "risk_tier": "security",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/tg-ingest.test.ts",
    "grep -E '(insertTgMessage|insertTgMessages)' src/services/tg-ingest.ts",
    "test -z \"$(grep -RE 'insertTgMessages?\\(' scripts/ src/ | grep -v src/services/tg-ingest.ts | grep -v src/db/tables/tg-messages.ts | grep -v src/repositories/telegram.repo.ts | grep -v src/db/index.ts | grep -v tests/)\""
  ],
  "diff_budget_loc": 260,
  "file_count_max": 4,
  "rollback": "git revert; ingest reverts to direct insertTgMessages calls. No column was added, so DB stays compatible.",
  "whitelist_add": "src/services/tg-ingest.ts → 260 (new ingest-orchestration module)",
  "escalation_triggers": [
    "A second ingest call site exists outside scripts/ that this packet does not enumerate (the spec lists scripts/tg-reindex.ts as the only current ingest path; if a poller-side insert is also writing tg_messages, escalate).",
    "TgMessagesTable.insertMany cannot be wrapped without breaking the in-place transaction semantics.",
    "tg-ingest.test.ts cannot reach >=80% line coverage of the new helper."
  ],
  "glossary": {
    "applyAtIngest(row)": "Pure function in src/services/tg-ingest.ts: takes TgMessageInsert, returns TgMessageInsert with text replaced by scrubPII(text).scrubbed. Does not touch the DB. Tested in isolation."
  }
}
```

---

## 8e-3 — Schema migration 20: `tg_chats` policy table  (escalate — `schema`)

```json
{
  "task_id": "8e-3",
  "goal": "Add SQLite migration 20 in src/db/schema.ts that creates table tg_chats(chat_id TEXT PRIMARY KEY, chat_title TEXT NOT NULL DEFAULT '', policy TEXT NOT NULL DEFAULT 'metadata_only' CHECK(policy IN ('ingest','ingest_scrubbed','metadata_only','exclude')), reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())), seeds it from existing tg_excluded_chats with policy='exclude', drops tg_excluded_chats, recreates a SQL view named tg_excluded_chats SELECTing chat_id/chat_title/reason/created_at FROM tg_chats WHERE policy='exclude' for back-compat SELECTs only, and adds column pii_scrubbed_at INTEGER NULL to tg_messages — all inside a single db.transaction() with PRAGMA user_version = 20.",
  "non_goals": [
    "Do not edit any code under src/repositories/, src/db/tables/, src/services/, or src/mcp/ in this packet — the back-compat view keeps existing SELECTs working; DML updates to exclude/include are handled in 8e-5.",
    "Do not rename insertTgChat / getExcludedTgChats etc.",
    "Do not write any new index besides one on tg_chats(policy).",
    "Do not seed tg_chats from any source other than tg_excluded_chats (no auto-discovery from tg_messages.chat_id)."
  ],
  "allowed_write_paths": [
    "src/db/schema.ts",
    "tests/schema-migration-20.test.ts"
  ],
  "read_context": [
    "src/db/schema.ts:282-360",
    "src/db/schema.ts:860-879",
    "src/db/tables/chats.ts:80-110"
  ],
  "risk_tier": "schema",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/schema-migration-20.test.ts",
    "rm -f /tmp/sb-mig20.db && bun -e \"import {MemoryDB} from './src/db'; const m = new MemoryDB('/tmp/sb-mig20.db'); const ver = (m.db.query('PRAGMA user_version').get() as {user_version:number}).user_version; if (ver !== 20) process.exit(1);\"",
    "bun -e \"import {Database} from 'bun:sqlite'; const db = new Database('/tmp/sb-mig20.db'); const r = db.query(\\\"SELECT sql FROM sqlite_master WHERE name='tg_chats'\\\").get(); if (!r) process.exit(1);\""
  ],
  "diff_budget_loc": 240,
  "file_count_max": 2,
  "rollback": "Cannot reverse a SQLite migration without a separate down-migration; instead, recovery = restore DB from latest backup taken before deploy. Document that recovery path in the PR description; do not write a down-migration in this packet.",
  "escalation_triggers": [
    "PRAGMA user_version is already > 19 at packet-execution time (another migration landed; renumber and ESCALATE).",
    "tg_excluded_chats is referenced by FK or triggers that the back-compat view cannot satisfy.",
    "Tests cannot be written that survive existing schema fixtures without DB reset.",
    "Kimi attempts to run this packet — STOP, return `requires_strong_model`."
  ],
  "glossary": {
    "back-compat view": "CREATE VIEW tg_excluded_chats AS SELECT chat_id, chat_title, reason, created_at FROM tg_chats WHERE policy='exclude'. ChatRepository getExcludedTgChats / getExcludedTgChatIds keep working unchanged because SQLite views are SELECT-transparent. Note: views are NOT INSERT/DELETE-transparent; excludeTgChat / includeTgChat DML is updated in 8e-5 to target tg_chats directly."
  }
}
```

---

## 8e-4 — Backfill scrub of existing `tg_messages` rows  (escalate — `db`)

```json
{
  "task_id": "8e-4",
  "goal": "Add scripts/tg-pii-backfill.ts that iterates every row of tg_messages where pii_scrubbed_at IS NULL, replaces row.text with scrubPII(row.text).scrubbed, sets pii_scrubbed_at = unixepoch(), batches updates of 500 in a single db.transaction(), prints progress every 1000 rows (counts only, never sample text), and refuses to run unless argv contains --confirm.",
  "non_goals": [
    "Do not delete or recreate the tg_messages table.",
    "Do not rebuild the FTS index inside the script — let SQLite triggers fire on UPDATE.",
    "Do not call scripts/tg-reindex.ts or any TG network operation.",
    "Do not write a parallel runner — single SQLite connection, one transaction per 500-row batch.",
    "Do not log sample message text in progress output (residual PII risk)."
  ],
  "allowed_write_paths": [
    "scripts/tg-pii-backfill.ts",
    "tests/tg-pii-backfill.test.ts"
  ],
  "read_context": [
    "src/db/tables/tg-messages.ts",
    "src/lib/pii-scrub.ts",
    "scripts/tg-reindex.ts",
    "scripts/audit-db.ts"
  ],
  "risk_tier": "db",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/tg-pii-backfill.test.ts",
    "bun run scripts/tg-pii-backfill.ts 2>&1 | grep -q -- '--confirm'",
    "rm -f data/test-backfill.db && bun -e \"import {Database} from 'bun:sqlite'; const db = new Database('data/test-backfill.db', {create:true}); db.run(\\\"CREATE TABLE tg_messages (message_id INTEGER, chat_id TEXT, chat_name TEXT DEFAULT '', from_name TEXT DEFAULT '', ts INTEGER, text TEXT, created_at INTEGER DEFAULT (unixepoch()), pii_scrubbed_at INTEGER, PRIMARY KEY(chat_id, message_id))\\\"); db.run(\\\"INSERT INTO tg_messages VALUES (1,'c','','x',0,'mail a@b.com',0,NULL)\\\"); db.close();\" && DB_PATH=data/test-backfill.db bun run scripts/tg-pii-backfill.ts --confirm && bun -e \"import {Database} from 'bun:sqlite'; const db = new Database('data/test-backfill.db'); const r = db.query('SELECT text, pii_scrubbed_at FROM tg_messages').get() as any; if (!r.text.includes('[REDACTED:email]')) process.exit(1); if (!r.pii_scrubbed_at) process.exit(1);\" && rm -f data/test-backfill.db"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 2,
  "rollback": "There is NO automated reverse path — original plaintext is destructively replaced. Recovery requires re-running scripts/tg-reindex.ts to refetch from Telegram (data lives upstream). Document that explicitly in the PR description.",
  "escalation_triggers": [
    "Migration 20 from 8e-3 has not yet landed — pii_scrubbed_at column does not exist.",
    "tg_messages row count > 500_000 (script needs to be re-validated for memory/lock contention before run on prod).",
    "FTS index becomes inconsistent after batched UPDATE on the content table.",
    "Kimi attempts to run this packet — STOP, return `requires_strong_model`."
  ],
  "glossary": {
    "--confirm": "Mandatory CLI flag. Without it, the script prints a help banner and exits 1. This guards prod accidents (per CLAUDE.md guardrail 13)."
  }
}
```

---

## 8e-5 — MCP tool surface: `tg_set_chat_policy` + `tg_list_chats` shows policy

```json
{
  "task_id": "8e-5",
  "goal": "Register MCP tool tg_set_chat_policy(chat_id:string, policy:'ingest'|'ingest_scrubbed'|'metadata_only'|'exclude', chat_title?:string, reason?:string) in src/mcp/registry/telegram.tools.ts with scope:'agent-only' that UPSERTs into tg_chats and updates updated_at, extend ChatRepository with setChatPolicy(...) and listKnownTgChats() in src/repositories/chat.repo.ts (with raw SQL in src/db/tables/chats.ts), update ChatsTable.excludeTgChat to INSERT/UPDATE tg_chats with policy='exclude' and includeTgChat to DELETE from tg_chats (view is SELECT-only back-compat), and extend the existing tg_list_chats handler so the returned objects include a `policy` field sourced from tg_chats (default 'metadata_only' if no row).",
  "non_goals": [
    "Do not change any other tg_* tool signature (tg_read_chat, tg_search_messages, telegram_search, tg_send_message, tg_list_excluded all stay byte-identical in shape).",
    "Do not add a frontend page or vue component for policy.",
    "Do not call userbot from setChatPolicy — pure DB write.",
    "Do not auto-rescrub historical rows when policy changes (rescrub is a separate operator action via 8e-4 script)."
  ],
  "allowed_write_paths": [
    "src/mcp/registry/telegram.tools.ts",
    "src/repositories/chat.repo.ts",
    "src/db/tables/chats.ts",
    "tests/tg-policy-tool.test.ts"
  ],
  "read_context": [
    "src/mcp/registry/telegram.tools.ts",
    "src/db/tables/chats.ts:80-110",
    "src/repositories/chat.repo.ts:30-50",
    "src/mcp/telegram-tools.ts:80-110"
  ],
  "risk_tier": "security",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/tg-policy-tool.test.ts",
    "grep -q 'tg_set_chat_policy' src/mcp/registry/telegram.tools.ts",
    "grep -q \"scope: \\\"agent-only\\\"\" src/mcp/registry/telegram.tools.ts"
  ],
  "diff_budget_loc": 280,
  "file_count_max": 4,
  "rollback": "git revert. tg_chats rows added through the tool stay in the DB but are inert without the tool definition (legacy code only reads tg_excluded_chats view).",
  "escalation_triggers": [
    "agent-loop's tool dispatcher cannot resolve 'agent-only' scope for tg_set_chat_policy.",
    "ToolExecutor in src/mcp/telegram-tools.ts has no pass-through for setChatPolicy and adding one breaks an unrelated test.",
    "tg_list_chats handler is shared with userbot listChats and adding a `policy` field breaks an existing consumer."
  ],
  "glossary": {
    "agent-only": "Scope value defined in src/mcp/registry/tool-registry.ts; tool is exposed to the autonomous loop but NOT to the public REST/MCP surface. Intentional — only operator agents change ingest policy."
  }
}
```

---

## 8e-6 — Search behavior on scrubbed text

```json
{
  "task_id": "8e-6",
  "goal": "Update the JSDoc on TgMessagesTable.search in src/db/tables/tg-messages.ts and on tg_search_messages + telegram_search registry entries in src/mcp/registry/telegram.tools.ts to state that the FTS index is built over scrubbed text (PII tokens appear as [REDACTED:<type>] in results) and that recall on PII queries is intentionally lower; add a runtime guard in src/db/tables/tg-messages.ts:search that, if the raw opts.query (before sanitizeFtsQuery) contains the literal substring 'REDACTED:', throws an Error('pii_query_blocked') so callers cannot probe the redaction marker.",
  "non_goals": [
    "Do not change the FTS schema, tokenizer, or trigger definitions.",
    "Do not introduce a separate non-scrubbed search path.",
    "Do not change the wire shape of TgSearchHit.",
    "Do not log the rejected query string itself."
  ],
  "allowed_write_paths": [
    "src/db/tables/tg-messages.ts",
    "src/mcp/registry/telegram.tools.ts",
    "tests/tg-search-redaction.test.ts"
  ],
  "read_context": [
    "src/db/tables/tg-messages.ts",
    "src/mcp/registry/telegram.tools.ts",
    "src/lib/fts-utils.ts"
  ],
  "risk_tier": "security",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun test tests/tg-search-redaction.test.ts",
    "bun -e \"import {MemoryDB} from './src/db'; const m = new MemoryDB(':memory:'); try { m.searchTgMessages({query:'REDACTED:email'}); process.exit(1); } catch (e) { if (!String(e).includes('pii_query_blocked')) process.exit(1); }\""
  ],
  "diff_budget_loc": 180,
  "file_count_max": 3,
  "rollback": "git revert; behaviour reverts to pre-8e-6 (scrubbed text was already in DB; only the doc update + guard go away).",
  "escalation_triggers": [
    "sanitizeFtsQuery already strips ':' so a post-sanitization check never fires (doc now specifies pre-sanitization raw check; if this is still problematic, ESCALATE).",
    "An existing call site searches for the literal token 'REDACTED:' for legitimate auditing reasons (then carve a service-side bypass; do not silently break it)."
  ],
  "glossary": {
    "pii_query_blocked": "Stable error code surfaced as the Error.message; the autonomous loop will see it as a tool error and surrender the search rather than retry."
  }
}
```

---

## 8e-7 — Tests: end-to-end PII gate behavior

```json
{
  "task_id": "8e-7",
  "goal": "Write tests in tests/pii-gate.e2e.test.ts that prove (a) scrubPII round-trip preserves non-PII tokens byte-identical for 5 hand-written fixture strings, (b) a brand-new chat_id passed through tgListChats has policy='metadata_only' (default), (c) calling tg_set_chat_policy then re-running ingest stores text matching the policy (ingest=raw, ingest_scrubbed=scrubbed, metadata_only=empty, exclude=row absent), (d) running scripts/tg-pii-backfill.ts twice on the same DB results in identical row contents the second run (idempotency), and (e) night-cycle scrub.ts still loads and runs without error after this phase.",
  "non_goals": [
    "Do not write tests that hit a live NIM endpoint or a live Telegram server.",
    "Do not edit production source files in this packet (test-only).",
    "Do not depend on data/subbrain.db — every test creates its own :memory: or data/test-*.db DB.",
    "Do not add a top-level process.exit in any new test file (per repo convention)."
  ],
  "allowed_write_paths": [
    "tests/pii-gate.e2e.test.ts",
    "tests/fixtures/pii/sample-strings.json"
  ],
  "read_context": [
    "src/lib/pii-scrub.ts",
    "src/services/tg-ingest.ts",
    "src/db/tables/tg-messages.ts",
    "src/mcp/registry/telegram.tools.ts",
    "scripts/tg-pii-backfill.ts",
    "src/pipeline/night-cycle/steps/scrub.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/pii-gate.e2e.test.ts",
    "test $(grep -cE '^\\s*test\\(' tests/pii-gate.e2e.test.ts) -ge 5"
  ],
  "diff_budget_loc": 260,
  "file_count_max": 2,
  "rollback": "git revert; test-only.",
  "escalation_triggers": [
    "Any prior packet (8e-1 through 8e-6) is missing or merged in a different shape than this contract describes.",
    "data/test-*.db files leak between tests and cause flake (then add explicit fs.rmSync at top of each test).",
    "night-cycle scrub.ts changed signature — open a separate ticket; this packet stops at smoke-load."
  ],
  "glossary": {
    "round-trip preserves non-PII": "scrubPII('hello world') === { scrubbed:'hello world', redacted_count:0, types:[] } byte-identical."
  }
}
```
