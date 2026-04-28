/**
 * M-06: night-cycle reflect step (CoALA episodic → semantic consolidation).
 *
 * Group active layer2_context rows by `title` (post-extractor category), age
 * > 24h, access_count ≥ N, not superseded, not stale. Whitelist:
 * project|decision|bug|architecture|learning. For each group ≥ MIN_GROUP:
 * `memory` virtual role extracts one consolidated semantic fact (literal
 * "NULL" → skip). Skip-guard: `findDuplicate(...,'shared',cat,fact)` cosine
 * ≥ 0.85 vs same-category existing → skip. Else `insertShared kind='semantic'
 * source='reflect'` + `linkEdge(srcContext,'context',newId,'shared',
 * 'derives',1.0)` per source. Disabled via REFLECT_ENABLED=false. LLM/embed
 * errors → `llm_failures++`, never thrown.
 */
import type { MemoryDB } from "../../../db";
import type { MemoryService } from "../../../services/memory";
import type { ModelRouter } from "../../../lib/model-router";
import type { RAGPipeline } from "../../../rag";
import { findDuplicate } from "../../agent-pipeline/post/dedupe";
import { stripThinkTags } from "../types";
import { NIGHT_MODEL, nightLog } from "./shared";

const log = nightLog.child("reflect");

// Mirrors WHITELIST_CONTEXT in post/validators.ts; hard-coded so this step is
// independent of the post-pipeline import surface.
const CONTEXT_WHITELIST = ["project", "decision", "bug", "architecture", "learning"] as const;

const FACT_MAX_CHARS = 200;
const LLM_TIMEOUT_MS = 30_000;

export interface ReflectResult {
  groups_examined: number;
  facts_promoted: number;
  edges_created: number;
  llm_failures: number;
}

export interface ReflectDeps {
  memory: MemoryDB;
  memoryService: MemoryService;
  rag: RAGPipeline;
  router: ModelRouter;
  // M-10: optional manual-trigger knobs (MCP `memory_reflect`). Night-cycle
  // caller leaves these undefined and gets default behaviour.
  categoryFilter?: string;
  dryRun?: boolean;
}

interface GroupRow {
  category: string;
  n: number;
  ids: string;
  contents: string;
}

function readEnv(): { enabled: boolean; minAccess: number; minGroup: number; maxGroups: number } {
  const enabled = (process.env.REFLECT_ENABLED ?? "true").toLowerCase() !== "false";
  const minAccess = parseInt(process.env.REFLECT_MIN_ACCESS ?? "3", 10);
  const minGroup = parseInt(process.env.REFLECT_MIN_GROUP ?? "3", 10);
  const maxGroups = parseInt(process.env.REFLECT_MAX_GROUPS ?? "5", 10);
  return {
    enabled,
    minAccess: Number.isFinite(minAccess) && minAccess >= 1 ? minAccess : 3,
    minGroup: Number.isFinite(minGroup) && minGroup >= 2 ? minGroup : 3,
    maxGroups: Number.isFinite(maxGroups) && maxGroups >= 1 ? maxGroups : 5,
  };
}

function selectGroups(memory: MemoryDB, minAccess: number, minGroup: number, maxGroups: number): GroupRow[] {
  return memory.memoryRepo.reflectGroups(CONTEXT_WHITELIST, minAccess, minGroup, maxGroups);
}

async function callLLM(
  router: ModelRouter,
  category: string,
  contents: string[],
): Promise<string | null> {
  const list = contents
    .map((c, i) => `${i + 1}. ${c.replace(/\s+/g, " ").slice(0, 500)}`)
    .join("\n");
  const system =
    "You are a memory consolidator. Given a list of related context-memo entries from the same category, extract one consolidated semantic fact that captures the recurring pattern. If there is no clear pattern, respond with exactly: NULL.";
  const user = `Category: ${category}\nEntries:\n${list}\n\nReturn one of:\n- A single sentence ≤200 chars stating the consolidated fact.\n- The literal string NULL.`;
  const signal = AbortSignal.timeout(LLM_TIMEOUT_MS);
  const resp = await router.chat(
    NIGHT_MODEL,
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 250,
      temperature: 0.1,
      signal,
    },
    "low",
  );
  const raw = resp.choices?.[0]?.message?.content ?? "";
  const text = stripThinkTags(raw).trim();
  if (!text) return null;
  // Accept NULL, "NULL", null, NULL., etc — terse-model wrappers vary.
  if (/^"?null"?\.?$/i.test(text)) return null;
  return text.slice(0, FACT_MAX_CHARS);
}

async function processGroup(
  group: GroupRow,
  deps: ReflectDeps,
): Promise<{ promoted: boolean; edges: number }> {
  const ids = group.ids.split("|").filter(Boolean);
  const contents = group.contents.split("⟂").filter(Boolean);
  const fact = await callLLM(deps.router, group.category, contents);
  if (!fact) return { promoted: false, edges: 0 };

  // Skip-guard: existing shared row covers same-category fact.
  const dup = await findDuplicate(deps.memory, deps.rag, "shared", group.category, fact);
  if (dup.id) {
    log.info(`skip-guard hit: category=${group.category} dup=${dup.id.slice(0, 8)} (${dup.source})`);
    return { promoted: false, edges: 0 };
  }

  // M-10: dryRun (manual MCP trigger) — counts the group as promotable but
  // skips the actual insert + edge linking. Caller uses this to preview what
  // a real reflect would do without mutating shared_memory.
  if (deps.dryRun) {
    log.info(
      `dryRun: category=${group.category} sources=${ids.length} (no insert)`,
    );
    return { promoted: true, edges: 0 };
  }

  const newId = await deps.memoryService.insertShared({
    category: group.category,
    content: fact,
    kind: "semantic",
    confidence: 0.7,
    source: "reflect",
  });

  let edges = 0;
  for (const srcId of ids) {
    const inserted = deps.memory.linkEdge(srcId, "context", newId, "shared", "derives", 1.0);
    if (inserted) edges++;
  }
  log.info(
    `promoted: category=${group.category} newId=${newId.slice(0, 8)} sources=${ids.length} edges=${edges}`,
  );
  return { promoted: true, edges };
}

export async function runReflect(deps: ReflectDeps): Promise<ReflectResult> {
  const cfg = readEnv();
  const result: ReflectResult = {
    groups_examined: 0,
    facts_promoted: 0,
    edges_created: 0,
    llm_failures: 0,
  };
  if (!cfg.enabled) {
    log.info("disabled (REFLECT_ENABLED=false)");
    return result;
  }
  // M-10 fix-round: when `categoryFilter` is set, fetch UNCAPPED then filter
  // and cap. Pre-fix the filter ran AFTER `maxGroups` cap, so a manual
  // `memory_reflect{category:"learning"}` returned groups_examined=0 if
  // learning sat at rank 6+ in the unfiltered top. Night-cycle path stays
  // capped (no filter → same behavior as before).
  let groups = deps.categoryFilter
    ? selectGroups(deps.memory, cfg.minAccess, cfg.minGroup, Number.MAX_SAFE_INTEGER)
        .filter((g) => g.category === deps.categoryFilter)
        .slice(0, cfg.maxGroups)
    : selectGroups(deps.memory, cfg.minAccess, cfg.minGroup, cfg.maxGroups);
  result.groups_examined = groups.length;
  if (groups.length === 0) {
    log.info("no groups to reflect on");
    return result;
  }
  for (const g of groups) {
    try {
      const r = await processGroup(g, deps);
      if (r.promoted) result.facts_promoted++;
      result.edges_created += r.edges;
    } catch (err) {
      result.llm_failures++;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`group ${g.category} failed: ${msg}`);
    }
  }
  log.info(
    `done: groups=${result.groups_examined} promoted=${result.facts_promoted} edges=${result.edges_created} failures=${result.llm_failures}`,
  );
  return result;
}
