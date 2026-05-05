/** M-05/M-05.1/M-05.2: post-insert edge hook. See docs/completed/05-rag-pipeline.md. */
import type { MemoryDB } from "@subbrain/core/db";
import type { RequestLogger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "../../../lib/model-router";
import type { RAGPipeline } from "../../../rag";

export const LINK_RELATED_TOP_N = 3;

const MAX_TAGS_DEFAULT = 10;
const MIN_CONTRADICTION_CONF_DEFAULT = 0.7;

// Default true; only explicit "false" (case-insensitive) disables.
const evolveEnabled = (): boolean =>
  process.env.LINK_EVOLVE_TAGS_ENABLED?.toLowerCase() !== "false";

function maxTags(): number {
  const n = Number.parseInt(process.env.LINK_EVOLVE_MAX_TAGS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : MAX_TAGS_DEFAULT;
}

const detectEnabled = (): boolean => process.env.LINK_CONTRADICT_ENABLED?.toLowerCase() === "true";

function minConf(): number {
  const n = Number.parseFloat(process.env.LINK_CONTRADICT_MIN_CONF ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : MIN_CONTRADICTION_CONF_DEFAULT;
}

const contradictModel = (): string => process.env.CONTRADICT_MODEL_ROLE ?? "memory";

/** Exported CSV splitter — caller-side use in `extractors.ts`. */
export function parseTagsCsv(csv: string): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function mergeUnique(a: string[], b: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...a, ...b])
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  // Tail-truncate: drop oldest when over cap.
  return out.length > cap ? out.slice(out.length - cap) : out;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const t of b) if (!sa.has(t)) return false;
  return true;
}

function evolveNeighbour(
  memory: MemoryDB,
  neighbourId: string,
  neighbourLayer: "context" | "shared",
  insertedTags: string[],
  cap: number,
): void {
  if (insertedTags.length === 0) return;
  const row =
    neighbourLayer === "context" ? memory.getContext(neighbourId) : memory.getShared(neighbourId);
  if (!row) return; // deleted mid-flight.
  const currentTags = parseTagsCsv(row.tags ?? "");
  const merged = mergeUnique(currentTags, insertedTags, cap);
  if (sameSet(currentTags, merged)) return; // already covered.
  const csv = merged.join(",");
  if (neighbourLayer === "context") memory.updateContext(neighbourId, { tags: csv });
  else memory.updateShared(neighbourId, { tags: csv });
}

interface ContradictionCandidate {
  id: string;
  layer: "context" | "shared";
  content: string;
}
interface ContradictionVerdict {
  id: string;
  confidence: number;
}

/** Best-effort LLM call. Bad JSON / throw / non-array → `[]` + warn. */
async function detectContradictions(
  router: ModelRouter,
  log: RequestLogger,
  insertedContent: string,
  candidates: ContradictionCandidate[],
): Promise<ContradictionVerdict[]> {
  const sys =
    "You detect direct contradictions between memory snippets. " +
    'Reply ONLY in JSON: {"contradicts":[{"id":"<id>","confidence":0.0-1.0}]}. ' +
    "Empty array if no contradiction. Do NOT explain. " +
    "A contradiction means the new fact directly negates a candidate (opposite preference, " +
    "reversed decision, conflicting attribute). Loose-relatedness is NOT contradiction.";
  const user =
    `NEW: ${insertedContent.slice(0, 800)}\n\nCANDIDATES:\n` +
    candidates.map((c) => `- id=${c.id}: ${c.content.slice(0, 400)}`).join("\n");

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
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) {
    log.warn("post.extractors", `detectContradictions: no JSON object (head: ${raw.slice(0, 80)})`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(first, last + 1));
  } catch (err) {
    log.warn(
      "post.extractors",
      `detectContradictions JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  const arr = (parsed as { contradicts?: unknown })?.contradicts;
  if (!Array.isArray(arr)) return [];
  const out: ContradictionVerdict[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    const conf = (item as { confidence?: unknown }).confidence;
    if (typeof id !== "string" || typeof conf !== "number" || !Number.isFinite(conf)) continue;
    out.push({ id, confidence: Math.min(1, Math.max(0, conf)) });
  }
  return out;
}

export async function linkRelated(
  memory: MemoryDB,
  rag: RAGPipeline,
  router: ModelRouter,
  insertedId: string,
  layer: "context" | "shared",
  content: string,
  insertedTags: string[],
  log: RequestLogger,
): Promise<void> {
  // M-05 weight is constant 1.0 (presence, not strength). RAG `score` with
  // skipRerank is RRF-rank-derived, not similarity. Strength → M-05.1.
  const drawnNeighbours: { id: string; layer: "context" | "shared" }[] = [];

  try {
    const neighbours = await rag.search({
      query: content,
      layers: [layer],
      rerankTopN: LINK_RELATED_TOP_N,
      skipRerank: true,
    });
    let drawn = 0;
    for (const n of neighbours) {
      if (drawn >= LINK_RELATED_TOP_N) break;
      if (n.id === insertedId) continue;
      try {
        memory.linkEdge(insertedId, layer, n.id, n.layer, "relates", 1.0);
        drawn++;
        if (n.layer === "context" || n.layer === "shared")
          drawnNeighbours.push({ id: n.id, layer: n.layer });
      } catch (err) {
        log.warn(
          "post.extractors",
          `linkRelated edge insert failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (
        insertedTags.length > 0 &&
        evolveEnabled() &&
        (n.layer === "context" || n.layer === "shared")
      ) {
        try {
          evolveNeighbour(memory, n.id, n.layer, insertedTags, maxTags());
        } catch (err) {
          log.warn(
            "post.extractors",
            `evolveNeighbour failed for ${n.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    log.warn(
      "post.extractors",
      `linkRelated failed for ${insertedId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // M-05.2: contradiction detection (default off; one LLM call vs drawnNeighbours).
  if (!detectEnabled() || drawnNeighbours.length === 0) return;
  try {
    const candidates: ContradictionCandidate[] = [];
    for (const n of drawnNeighbours) {
      const row = n.layer === "context" ? memory.getContext(n.id) : memory.getShared(n.id);
      if (!row) continue; // deleted mid-flight.
      candidates.push({ id: n.id, layer: n.layer, content: row.content });
    }
    if (candidates.length === 0) return;
    const verdicts = await detectContradictions(router, log, content, candidates);
    const threshold = minConf();
    for (const v of verdicts) {
      if (v.confidence < threshold) continue;
      const cand = candidates.find((c) => c.id === v.id);
      if (!cand) continue; // hallucinated id.
      try {
        memory.linkEdge(insertedId, layer, cand.id, cand.layer, "contradicts", v.confidence);
      } catch (err) {
        log.warn(
          "post.extractors",
          `contradiction edge insert failed for ${cand.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    log.warn(
      "post.extractors",
      `detectContradictions failed for ${insertedId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
