/**
 * Free runner — executes pool tasks of type "free" via AgentLoop.run.
 *
 * Token-budget abort + structured done_with_artifact parsing.
 */
import type { AgentLoop } from "../../../pipeline/agent-loop";
import type { AgentTaskRecord } from "@subbrain/core/db/tables/agent-tasks/types";
import { logger } from "@subbrain/core/lib/logger";
import type { RunnerResult } from "../types";

const SYSTEM = `Ты выполняешь pool-задачу type=free. Промпт пользовательской задачи ниже.

ACCEPTANCE: вызови \`done_with_artifact\` с status="complete" + artifact (объект {type, content, url?}) ИЛИ status="noop" + reason (строка ≥10 chars). Без этого вызова task → failed.

ANTI-ECONOMY: используй tools агрессивно. Лучше 50 шагов с артефактом чем 5 шагов "noop по неуверенности". \`memory_search\` перед \`memory_write\` — cheap insurance, делай всегда.

CONSULT: перед commit'ом любого non-trivial подхода — \`consult_chaos\` (что может пойти не так?). Перед architecturally-irreversible решением — \`consult_specialists\`. Quotas (5 chaos / 6 specialists) — safety rails, не budgets.

ANTI-IDLE: 3 read-only шага подряд → переключайся, у тебя есть write-tools.

SAFETY: payments / irreversible writes / cookies — запрещено. SMS/email/PR-submit — suggest через TG-confirm flow, не direct.

PRIORITY ORDER: D1 (создать code-tool со smoke-pass) > D3 (web-route ≥5 clicks с артефактом) > D4 (PR/issue draft) > D2 (research, ≤3 facts в shared/context). Research — fallback, не дефолт.

ЗАДАЧА:
{task.prompt}`;

function buildPrompt(task: AgentTaskRecord): string {
  return SYSTEM.replace("{task.prompt}", task.prompt);
}

export async function runFreeTask(agentLoop: AgentLoop, task: AgentTaskRecord): Promise<RunnerResult> {
  const log = logger.child("pool.runner");
  const maxTokens = Number(process.env.AGENT_POOL_MAX_TOKENS_FREE ?? process.env.AGENT_POOL_MAX_TOKENS_PER_TASK ?? 60_000);
  let consumed = 0;
  const tokenAbort = new AbortController();

  const onUsage = (u: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => {
    consumed += u.total_tokens ?? 0;
    if (consumed > maxTokens) {
      tokenAbort.abort(new Error("token_budget_exceeded"));
    }
  };

  let result;
  try {
    result = await agentLoop.run({
      task: task.prompt,
      model: "teamlead",
      priority: "low",
      maxSteps: 50,
      agentMode: "scheduled",
      agentId: "agent-pool",
      systemMessage: buildPrompt(task),
      userMessage: task.prompt,
      signal: tokenAbort.signal,
      onUsage,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (tokenAbort.signal.aborted || reason.includes("token_budget_exceeded") || reason.includes("AbortError")) {
      log.warn("token_budget_exceeded", { meta: { task_id: task.id, type: task.type, consumed, cap: maxTokens } });
      return { status: "failed", reason: "token_budget_exceeded" };
    }
    log.error("run threw", { meta: { task_id: task.id, reason } });
    return { status: "failed", reason };
  }

  const final = result.finalAnswer.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(final);
  } catch {
    parsed = undefined;
  }

  if (isDoneWithArtifact(parsed)) {
    const d = parsed as { status: string; artifact?: unknown; reason?: string };
    if (d.status === "complete") {
      const artifact = parseArtifact(d.artifact);
      if (!artifact) {
        return { status: "failed", reason: "complete missing valid artifact" };
      }
      return { status: "complete", artifact };
    }
    if (d.status === "noop") {
      return { status: "noop", reason: d.reason || "no reason given" };
    }
    if (d.status === "failed") {
      return { status: "failed", reason: d.reason || "no reason given" };
    }
  }

  // Fallback: treat plain-text finalAnswer as noop if non-empty, else failed.
  if (final.length > 0) {
    return { status: "noop", reason: final.slice(0, 500) };
  }
  return { status: "failed", reason: "empty final answer" };
}

function isDoneWithArtifact(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    "status" in v &&
    typeof (v as Record<string, unknown>).status === "string"
  );
}

function parseArtifact(v: unknown): { type: string; content: unknown; url?: string } | null {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      return parseArtifact(parsed);
    } catch {
      return { type: "text", content: v };
    }
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.type !== "string") return null;
  return { type: o.type, content: o.content, url: typeof o.url === "string" ? o.url : undefined };
}
