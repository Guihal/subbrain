/**
 * @subbrain/plugin-tg-gates
 *
 * Scheduled-only hard-gate for `tg_send_message`.
 * Replaces inline checkSpamGate in telegram.tools.ts.
 *
 * Reads `layer1_focus.no_repetitive_tg_spam`; returns `rejected` when
 * the directive is fresh + non-empty. Interactive runs pass through.
 *
 * Background: ~/vault/RLM/Daily/2026-04-28.md — 27.04.2026 free-agent
 * fake-digest incident. See F-4 in docs/tasks/code-tools-poisoning-fix.md.
 */

import { logger } from "@subbrain/core/lib/logger";
import type { Plugin, ToolResult } from "@subbrain/plugin";
import type { ToolExecutor } from "../../src/mcp/executor";
import type { AgentMode } from "../../src/pipeline/agent-loop/types";

const log = logger.child("tg-gates");
const FOCUS_BLOCK_KEY = "no_repetitive_tg_spam";
const FOCUS_TTL_SEC = 7 * 86400;

interface Ctx {
  executor?: ToolExecutor;
  agentMode?: AgentMode;
}

export const tgGatesPlugin: Plugin = {
  name: "@subbrain/plugin-tg-gates",
  setup({ hooks }) {
    hooks.onToolBefore(async ({ toolName, ctx }) => {
      if (toolName !== "tg_send_message") return undefined;

      const mode = (ctx as Ctx)?.agentMode;
      if (mode !== "scheduled") return undefined;

      const executor = (ctx as Ctx)?.executor;
      if (!executor) return undefined;

      const block = executor.memoryDb.getFocusWithMeta(FOCUS_BLOCK_KEY);
      if (!block || block.value.trim() === "") return undefined;

      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.max(0, nowSec - block.updated_at) >= FOCUS_TTL_SEC) return undefined;

      const ageH = ((nowSec - block.updated_at) / 3600).toFixed(1);
      log.warn(
        `tg_send_message blocked by layer1.${FOCUS_BLOCK_KEY} (focus_blocked, set ${ageH}h ago)`,
        { meta: { key: FOCUS_BLOCK_KEY, updated_at: block.updated_at, age_h: ageH } },
      );

      return {
        kind: "rejected" as const,
        error: {
          code: "focus_blocked",
          message: `layer1_focus.${FOCUS_BLOCK_KEY} active (set ${ageH}h ago); reset via deleteFocus or wait ${FOCUS_TTL_SEC / 86400}d`,
        },
      } satisfies ToolResult;
    });
  },
};
