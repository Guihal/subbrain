/**
 * M-11: sleep-time focus block rewriter (Letta / MemGPT pattern).
 *
 * For every editable layer1_focus key (PROTECTED_FOCUS_KEYS skipped — those
 * are scheduler bookkeeping, not user-visible directives), build a synthesis
 * prompt around the top-K shared_memory rows ranked by `kind*salience*log
 * (access_count)` and ask the `memory` virtual role for an updated value.
 *
 * Writes land in `layer1_focus_shadow` ONLY — real `layer1_focus` is not
 * touched, so `system-prompt.ts` keeps reading the human-curated values.
 * Shadow exists so a human can diff weeks of proposed rewrites before any
 * flip; flip itself is out of scope for M-11.
 *
 * Env-gated: `NIGHT_CYCLE_FOCUS_REWRITE_ENABLED=true` flips it on. Default
 * off → returns zeros without an LLM call. `NIGHT_CYCLE_MODEL` (default
 * `memory`) selects the role; matches all other night-cycle LLM steps.
 *
 * Skip semantics: LLM echoes current value (no-op signal), or returns a
 * value over MAX_FOCUS_LEN (truncation would lose meaning), or returns
 * empty/whitespace → `skipped++`. LLM throw → `errors++`. Per-key failures
 * never abort the loop — orchestrator wraps the whole step in `runStep`
 * which already handles step-level throws via `result.errors`.
 */
import type { MemoryDB } from "../../../db";
import type { ModelRouter } from "../../../lib/model-router";
import type { ScopedLogger } from "../../../lib/logger";
import { PROTECTED_FOCUS_KEYS } from "../prune/focus";
import { stripThinkTags } from "../types";
import { NIGHT_MODEL, nightLog } from "./shared";
import type { FocusRewriteResult } from "../types";

const REWRITE_TOP_K_DEFAULT = 30;
const MAX_FOCUS_LEN_DEFAULT = 500;
const FOCUS_REWRITE_MAX_TOKENS = 600;

interface SharedTop {
  id: string;
  category: string;
  kind: string;
  content: string;
  salience: number | null;
  last_accessed_at: number | null;
  access_count: number;
}

export interface FocusRewriteDeps {
  memory: MemoryDB;
  router: ModelRouter;
  log?: ScopedLogger;
}

function readEnv(): { enabled: boolean; topK: number; maxLen: number } {
  const enabled =
    (process.env.NIGHT_CYCLE_FOCUS_REWRITE_ENABLED ?? "").toLowerCase() ===
    "true";
  const rawTopK = parseInt(process.env.FOCUS_REWRITE_TOP_K ?? "", 10);
  const topK =
    Number.isFinite(rawTopK) && rawTopK >= 1 ? rawTopK : REWRITE_TOP_K_DEFAULT;
  const rawMaxLen = parseInt(process.env.FOCUS_REWRITE_MAX_LEN ?? "", 10);
  const maxLen =
    Number.isFinite(rawMaxLen) && rawMaxLen >= 32
      ? rawMaxLen
      : MAX_FOCUS_LEN_DEFAULT;
  return { enabled, topK, maxLen };
}

const FOCUS_REWRITE_PROMPT = `Ты обновляешь focus-блок layer1_focus — короткое (≤500 chars) утверждение, инжектится в КАЖДЫЙ system prompt.
Получаешь:
- Текущий focus key + value.
- Top-K shared memos (most relevant facts о пользователе/проекте).

Цель: переписать value так, чтобы он СИНТЕЗИРОВАЛ актуальные shared facts, остался ≤500 chars, и НЕ потерял существующий контекст из value.

Если current value уже актуален / shared не добавляет нового — выводи EXACT current value (no-op signal).

Output: ТОЛЬКО новый value (no JSON, no fences). Никаких meta-комментариев.`;

function buildUserContent(
  key: string,
  currentValue: string,
  topShared: SharedTop[],
): string {
  const list = topShared
    .map((t) => `[${t.kind}] ${t.category}: ${t.content}`)
    .join("\n");
  return `key: ${key}\ncurrent: ${currentValue}\n\ntop_shared:\n${list}`;
}

async function rewriteFocusBlock(
  router: ModelRouter,
  key: string,
  currentValue: string,
  topShared: SharedTop[],
): Promise<string> {
  const response = await router.chat(
    NIGHT_MODEL,
    {
      messages: [
        { role: "system", content: FOCUS_REWRITE_PROMPT },
        { role: "user", content: buildUserContent(key, currentValue, topShared) },
      ],
      max_tokens: FOCUS_REWRITE_MAX_TOKENS,
      temperature: 0.1,
    },
    "low",
  );
  const raw = response.choices[0]?.message?.content ?? "";
  return stripThinkTags(raw).trim();
}

export async function runFocusRewrite(
  deps: FocusRewriteDeps,
): Promise<FocusRewriteResult> {
  const log = deps.log ?? nightLog.child("focus-rewrite");
  const { enabled, topK, maxLen } = readEnv();
  if (!enabled) {
    return { rewritten: 0, skipped: 0, errors: 0 };
  }

  const all = deps.memory.getAllFocus();
  const editable = Object.entries(all).filter(
    ([k]) => !PROTECTED_FOCUS_KEYS.has(k),
  );
  if (editable.length === 0) {
    log.info("no editable focus keys → skip");
    return { rewritten: 0, skipped: 0, errors: 0 };
  }

  const topShared = deps.memory.selectTopSharedForFocusRewrite(topK);
  if (topShared.length === 0) {
    log.info("no shared memos → skip");
    return { rewritten: 0, skipped: 0, errors: 0 };
  }

  let rewritten = 0;
  let skipped = 0;
  let errors = 0;
  for (const [key, currentValue] of editable) {
    try {
      const newValue = await rewriteFocusBlock(
        deps.router,
        key,
        currentValue,
        topShared,
      );
      if (
        newValue.length > 0 &&
        newValue !== currentValue &&
        newValue.length <= maxLen
      ) {
        deps.memory.setShadowFocus(key, newValue);
        rewritten++;
        log.info(`shadow key=${key} len=${newValue.length}`);
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      log.warn(`${key} failed: ${(err as Error).message}`);
    }
  }
  log.info(`done rewritten=${rewritten} skipped=${skipped} errors=${errors}`);
  return { rewritten, skipped, errors };
}
