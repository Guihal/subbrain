/**
 * Teamlead synthesis call + degraded fallback when synthesis times out.
 * Uses AbortSignal.any to compose external signal with per-call timeout.
 */

import type { ModelRouter } from "../../lib/model-router";
import type { Metrics } from "../../lib/metrics";
import { buildSynthesisSystemPrompt } from "./prompts";
import { getSynthesisTimeout, type AgentResponse } from "./types";
import { getWeight, type TaskCategory } from "./weights";

const SYNTHESIS_TIMEOUT_SENTINEL: unique symbol = Symbol("synthesis_timeout");

interface SynthesisDeps {
  router: ModelRouter;
  metrics: Metrics | null;
}

/**
 * Build a degraded answer from raw specialist outputs when synthesis
 * times out. Picks top-2 by category weight so the agent still gets the
 * highest-signal opinions and a clear marker that synthesis failed.
 */
export function fallbackSynthesis(
  responses: AgentResponse[],
  category: TaskCategory,
): string {
  const ranked = [...responses].sort(
    (a, b) => getWeight(b.role, category) - getWeight(a.role, category),
  );
  const top = ranked.slice(0, 2);
  const sections = top
    .map((r) => `### ${r.role}\n${r.content}`)
    .join("\n\n---\n\n");
  return `⚠ Synthesis timed out (${getSynthesisTimeout()}ms) — раздаю top-${top.length} ответов специалистов как есть:\n\n${sections}`;
}

/**
 * Run teamlead synthesis with own timeout. Returns synthesized text or
 * fallback when the call exceeds SYNTHESIS_TIMEOUT.
 */
export async function runSynthesis(
  deps: SynthesisDeps,
  userMessage: string,
  responses: AgentResponse[],
  category: TaskCategory,
  externalSignal?: AbortSignal,
): Promise<string> {
  // Synthesis has its own timeout so a slow teamlead can't eat the whole
  // outer consult_* budget. On timeout we abort the in-flight router.chat
  // and fall back to the top-2 specialist responses by category weight —
  // partial answer beats burning 4 specialist RPM for nothing.
  const synthesisStart = Date.now();
  const synthCtrl = new AbortController();
  const synthSignal = externalSignal
    ? AbortSignal.any([externalSignal, synthCtrl.signal])
    : synthCtrl.signal;
  let synthTimer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    callTeamlead(deps, userMessage, responses, category, synthSignal),
    new Promise<typeof SYNTHESIS_TIMEOUT_SENTINEL>((resolve) => {
      synthTimer = setTimeout(() => {
        synthCtrl.abort();
        resolve(SYNTHESIS_TIMEOUT_SENTINEL);
      }, getSynthesisTimeout());
    }),
  ]).finally(() => {
    if (synthTimer) clearTimeout(synthTimer);
  });
  const synthesisTimedOut = raced === SYNTHESIS_TIMEOUT_SENTINEL;
  const synthesis = synthesisTimedOut
    ? fallbackSynthesis(responses, category)
    : (raced as string);
  deps.metrics?.record({
    model: "teamlead",
    priority: "critical",
    stage: "main",
    latencyMs: Date.now() - synthesisStart,
    tokensIn: 0,
    tokensOut: 0,
    status: synthesisTimedOut ? "error" : "ok",
    ...(synthesisTimedOut ? { errorType: "timeout" } : {}),
  });
  return synthesis;
}

async function callTeamlead(
  deps: SynthesisDeps,
  userMessage: string,
  responses: AgentResponse[],
  category: TaskCategory,
  signal?: AbortSignal,
): Promise<string> {
  const systemPrompt = buildSynthesisSystemPrompt(responses, category);

  const result = await deps.router.chat(
    "teamlead",
    {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: 4096,
      temperature: 0.5,
      signal,
    },
    "critical",
  );

  return result.choices[0]?.message?.content || "";
}
