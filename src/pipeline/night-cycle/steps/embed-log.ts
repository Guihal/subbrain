/**
 * M-04.1: rolling N-row vec embed for `layer4_log`.
 *
 * Wired AFTER all other night-cycle post-batch steps (heavy IO last).
 *
 * Window: keep at most `LOG_EMBED_CAP` (default 10000) most-recent log
 * rows in `vec_embeddings(layer='log')`. Each cycle:
 *   1. Compute `slack = cap - currentLogEmbeddings`.
 *   2. Pick `slack` newest log rows that don't yet have an embedding.
 *   3. Batch-embed via `rag.embedBatch` (one upstream NVIDIA call per
 *      `LOG_EMBED_BATCH`; default 50 — fan-out via `Promise.allSettled`).
 *   4. Upsert vectors inside `db.transaction()` so embed+index are atomic.
 *   5. After fill, evict oldest-by-`layer4_log.created_at` so the table
 *      never grows past `cap` (rolling window, count-based).
 *
 * Initial backfill = first cycle on a populated DB drains up to `cap`.
 * Steady state = each cycle embeds only the new rows since last run.
 *
 * Privacy: raw log holds pre-scrub user input. The vec layer is agent-only
 * (default RAG `layers` excludes `"log"`); this step does NOT scrub PII —
 * scrub already runs upstream in the main night-cycle batch on the rows it
 * compresses; rolling embed is for episodic semantic search by trusted
 * callers only.
 *
 * Errors are swallowed per batch (`embed_log_errors++`), never thrown out
 * of the step — same contract as cross-layer-dedup / reflect.
 *
 * Disabled via `LOG_EMBED_ENABLED=false`. Tunables: `LOG_EMBED_CAP`,
 * `LOG_EMBED_BATCH`. All env knobs read at call-time so tests can toggle
 * them per case without spawning a subprocess.
 */
import type { MemoryDB } from "../../../db";
import { logger } from "../../../lib/logger";
import type { RAGPipeline } from "../../../rag";

const log = logger.child("night.embed-log");

const DEFAULT_CAP = 10_000;
const DEFAULT_BATCH = 50;
const MIN_BATCH = 1;
const MAX_BATCH = 256; // sane upper bound; NVIDIA accepts more but RPM-cost climbs

export interface EmbedLogResult {
  embedded: number;
  evicted: number;
  errors: number;
}

export interface EmbedLogDeps {
  memory: MemoryDB;
  rag: RAGPipeline;
}

interface Cfg {
  enabled: boolean;
  cap: number;
  batch: number;
}

function readEnv(): Cfg {
  const enabled = (process.env.LOG_EMBED_ENABLED ?? "true").toLowerCase() !== "false";
  const capRaw = Number.parseInt(process.env.LOG_EMBED_CAP ?? "", 10);
  const cap = Number.isFinite(capRaw) && capRaw >= 0 ? capRaw : DEFAULT_CAP;
  const batchRaw = Number.parseInt(process.env.LOG_EMBED_BATCH ?? "", 10);
  let batch = Number.isFinite(batchRaw) && batchRaw >= MIN_BATCH ? batchRaw : DEFAULT_BATCH;
  if (batch > MAX_BATCH) batch = MAX_BATCH;
  return { enabled, cap, batch };
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const ZERO: EmbedLogResult = { embedded: 0, evicted: 0, errors: 0 };

export async function runEmbedLog(deps: EmbedLogDeps): Promise<EmbedLogResult> {
  const cfg = readEnv();
  if (!cfg.enabled) {
    log.info("skipped — LOG_EMBED_ENABLED=false");
    return { ...ZERO };
  }
  if (cfg.cap === 0) {
    // Cap=0 means "drop the window entirely". Evict everything, no fill.
    const evicted = deps.memory.logRepo.evictOldestLogEmbeddings(
      deps.memory.logRepo.countLogEmbeddings(),
    );
    log.info(`cap=0 — evicted=${evicted}`);
    return { embedded: 0, evicted, errors: 0 };
  }

  const { memory, rag } = deps;
  const existing = memory.logRepo.countLogEmbeddings();
  const slack = Math.max(0, cfg.cap - existing);

  let embedded = 0;
  let errors = 0;

  if (slack > 0) {
    const candidates = memory.logRepo.selectUnembeddedRecent(slack);
    const batches = chunk(candidates, cfg.batch);
    // Fan-out via `Promise.allSettled` — one batch failing doesn't kill
    // the rest. Each batch = one NVIDIA embed call (rate-limited via
    // `router.scheduleRaw("low", ...)` inside `rag.embedBatch`).
    const settled = await Promise.allSettled(
      batches.map(async (b) => {
        const vecs = await rag.embedBatch(b.map((r) => r.content));
        if (vecs.length !== b.length) {
          throw new Error(`embed shape mismatch: got ${vecs.length} vecs for ${b.length} rows`);
        }
        memory.db.transaction(() => {
          for (let i = 0; i < b.length; i++) {
            memory.upsertEmbedding(b[i].id, "log", vecs[i]);
          }
        })();
        return b.length;
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled") embedded += s.value;
      else {
        errors += 1;
        const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
        log.warn(`embed batch failed: ${msg}`);
      }
    }
  }

  // After fill, evict oldest beyond cap. The fill above never inserts past
  // the cap (slack-bounded), so eviction usually = 0. The branch survives
  // for the case where cap was lowered between cycles (existing > cap).
  const after = memory.logRepo.countLogEmbeddings();
  const overflow = Math.max(0, after - cfg.cap);
  const evicted = overflow > 0 ? memory.logRepo.evictOldestLogEmbeddings(overflow) : 0;

  log.info(
    `embedded=${embedded} evicted=${evicted} errors=${errors} cap=${cfg.cap} batch=${cfg.batch}`,
  );
  return { embedded, evicted, errors };
}
