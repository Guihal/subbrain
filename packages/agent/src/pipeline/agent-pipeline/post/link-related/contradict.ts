/** M-05.2: contradiction-detection helpers. See docs/completed/05-rag-pipeline.md. */
import type { RequestLogger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";

const MIN_CONTRADICTION_CONF_DEFAULT = 0.7;

export const detectEnabled = (): boolean =>
  process.env.LINK_CONTRADICT_ENABLED?.toLowerCase() === "true";

export function minConf(): number {
  const n = Number.parseFloat(process.env.LINK_CONTRADICTION_MIN_CONF ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : MIN_CONTRADICTION_CONF_DEFAULT;
}

export const contradictModel = (): string => process.env.CONTRADICT_MODEL_ROLE ?? "memory";

export interface ContradictionCandidate {
  id: string;
  layer: "context" | "shared";
  content: string;
}

export interface ContradictionVerdict {
  id: string;
  confidence: number;
}

function isContradictionArray(v: unknown): v is Array<{ id: string; confidence: number }> {
  if (!Array.isArray(v)) return false;
  for (const item of v) {
    if (!item || typeof item !== "object") return false;
    const id = (item as Record<string, unknown>).id;
    const conf = (item as Record<string, unknown>).confidence;
    if (typeof id !== "string" || typeof conf !== "number" || !Number.isFinite(conf)) return false;
  }
  return true;
}

function buildPrompt(
  insertedContent: string,
  candidates: ContradictionCandidate[],
): { sys: string; user: string } {
  const sys =
    "You detect direct contradictions between memory snippets. " +
    'Reply ONLY in JSON: {"contradicts":[{"id":"<id>","confidence":0.0-1.0}]}. ' +
    "Empty array if no contradiction. Do NOT explain. " +
    "A contradiction means the new fact directly negates a candidate (opposite preference, " +
    "reversed decision, conflicting attribute). Loose-relatedness is NOT contradiction.";
  const user =
    `NEW: ${insertedContent.slice(0, 800)}\n\nCANDIDATES:\n` +
    candidates.map((c) => `- id=${c.id}: ${c.content.slice(0, 400)}`).join("\n");
  return { sys, user };
}

function parseContradictionJson(raw: string): Array<{ id: string; confidence: number }> {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(first, last + 1));
  } catch {
    return [];
  }
  const arr = (parsed as Record<string, unknown>)?.contradicts;
  if (!isContradictionArray(arr)) return [];
  return arr;
}

/** Best-effort LLM call. Bad JSON / throw / non-array → `[]` + warn. */
export async function detectContradictions(
  router: ModelRouter,
  log: RequestLogger,
  insertedContent: string,
  candidates: ContradictionCandidate[],
  signal?: AbortSignal,
): Promise<ContradictionVerdict[]> {
  const { sys, user } = buildPrompt(insertedContent, candidates);

  let raw = "";
  try {
    const resp = await router.chat(
      contradictModel(),
      {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        temperature: 0.0,
        max_tokens: 256,
        signal,
      },
      "low",
    );
    raw = resp.choices[0]?.message?.content ?? "";
  } catch (err) {
    log.warn(
      "post.extractors",
      `detectContradictions LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const arr = parseContradictionJson(raw);
  if (arr.length === 0 && raw.length > 0) {
    log.warn("post.extractors", `detectContradictions: no JSON object (head: ${raw.slice(0, 80)})`);
  }

  return arr.map((v) => ({ id: v.id, confidence: Math.min(1, Math.max(0, v.confidence)) }));
}
