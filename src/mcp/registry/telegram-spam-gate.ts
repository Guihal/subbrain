/**
 * F-4: scheduled-only hard-gate for `tg_send_message`.
 *
 * Reads `layer1_focus.no_repetitive_tg_spam`; returns a `ToolError`-shaped
 * response when the directive is fresh + non-empty. Interactive runs (REST,
 * MCP, chat) are passed through — those callers have direct human control.
 *
 * Background: `~/vault/RLM/Daily/2026-04-28.md` — diagnosis of the
 * 27.04.2026 free-agent fake-digest incident. Spec lives in
 * `docs/tasks/code-tools-poisoning-fix.md`.
 */
import type { ToolExecutor } from "../executor";
import type { AgentMode } from "./tool-registry";
import { logger } from "../../lib/logger";

const log = logger.child("tg-tools");
const FOCUS_BLOCK_KEY = "no_repetitive_tg_spam";
const FOCUS_TTL_SEC = 7 * 86400;

export interface SpamGateBlock {
  success: false;
  error: string;
}

export function checkSpamGate(
  executor: ToolExecutor,
  agentMode: AgentMode | undefined,
): SpamGateBlock | null {
  if (agentMode !== "scheduled") return null;
  const block = executor.memoryDb.getFocusWithMeta(FOCUS_BLOCK_KEY);
  if (!block || block.value.trim() === "") return null;
  const nowSec = Math.floor(Date.now() / 1000);
  // Math.max clamps clock-skew (updated_at in future ⇒ diff stays 0).
  if (Math.max(0, nowSec - block.updated_at) >= FOCUS_TTL_SEC) return null;
  const ageH = ((nowSec - block.updated_at) / 3600).toFixed(1);
  log.warn(
    `tg_send_message blocked by layer1.${FOCUS_BLOCK_KEY} (focus_blocked, set ${ageH}h ago)`,
    { meta: { key: FOCUS_BLOCK_KEY, updated_at: block.updated_at, age_h: ageH } },
  );
  return {
    success: false,
    error: `focus_blocked: layer1_focus.${FOCUS_BLOCK_KEY} active (set ${ageH}h ago); reset via deleteFocus or wait ${FOCUS_TTL_SEC / 86400}d`,
  };
}
