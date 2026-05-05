/**
 * Night-cycle Step 11: weekly digest + retention for completed tasks.
 *
 * Per SQLite %W week (Monday-based ordinal, NOT ISO-8601) of `completed_at`,
 * done tasks older than 7 days are compressed into one `layer3_archive`
 * entry tagged `tasks,digest,YYYY-wNN`, embedded, and deleted from `tasks`.
 * Cancelled tasks older than 1 day are deleted without a digest.
 *
 * A digest for the same week can be updated on later cycles (tasks completed
 * at the tail of the week only become eligible after they turn 7d old), so
 * the existing digest row is looked up by exact tag and its content merged.
 * Combined content is capped at `MAX_CONTENT_CHARS` by dropping the OLDEST
 * lines — the newest context is preserved. Embed runs OUTSIDE the tx so a
 * failure just skips that week and retries on the next cycle.
 */
import { randomUUID } from "node:crypto";
import type { MemoryDB } from "../../../db";
import { logger } from "../../../lib/logger";

const log = logger.child("night.prune");
const DONE_AGE_SECONDS = 7 * 86400;
const CANCELLED_AGE_SECONDS = 86400;
const MAX_CONTENT_CHARS = 50_000;
const DIGEST_AGENT_ID = "night-cycle";

export interface Embedder {
  embedContent(content: string): Promise<Float32Array>;
}

interface WeekRow {
  week: string;
  n: number;
}

interface DoneTask {
  id: string;
  scope: string;
  title: string;
  description: string;
}

interface ExistingDigest {
  id: string;
  content: string;
}

export async function pruneCompletedTasks(memory: MemoryDB, rag: Embedder): Promise<number> {
  const weeks = memory.db
    .query(
      `SELECT strftime('%Y-W%W', completed_at, 'unixepoch') AS week,
              COUNT(*) AS n
       FROM tasks
       WHERE status = 'done' AND completed_at < unixepoch() - ?
       GROUP BY week`,
    )
    .all(DONE_AGE_SECONDS) as WeekRow[];

  let pruned = 0;

  for (const { week } of weeks) {
    const label = week.toLowerCase();
    const tag = `tasks,digest,${label}`;

    const tasks = memory.db
      .query(
        `SELECT id, scope, title, description FROM tasks
         WHERE status = 'done' AND completed_at < unixepoch() - ?
           AND strftime('%Y-W%W', completed_at, 'unixepoch') = ?`,
      )
      .all(DONE_AGE_SECONDS, week) as DoneTask[];
    if (tasks.length === 0) continue;

    const freshLines = tasks.map(
      (t) => `- [${t.scope}] ${t.title}${t.description ? `\n  ${t.description}` : ""}`,
    );
    const fresh = capFromHead(freshLines, tasks.length);

    const existing = memory.db
      .query(
        `SELECT id, content FROM layer3_archive
         WHERE tags = ? AND agent_id = ? LIMIT 1`,
      )
      .get(tag, DIGEST_AGENT_ID) as ExistingDigest | null;

    const combined = existing ? capFromTail(`${existing.content}\n${fresh}`) : fresh;

    let vec: Float32Array;
    try {
      vec = await rag.embedContent(combined);
    } catch (err) {
      log.warn(`embed week=${label} failed, will retry next cycle: ${String(err)}`);
      continue;
    }

    try {
      memory.transaction(() => {
        if (existing) {
          memory.updateArchive(existing.id, { content: combined });
          // vec0 virtual tables don't honor INSERT OR REPLACE: explicitly
          // delete the old embedding before re-inserting the updated one.
          memory.deleteEmbedding(existing.id);
          memory.upsertEmbedding(existing.id, "archive", vec);
        } else {
          // M-12 (mig 15): confidence REAL [0..1]; 0.9 = legacy "HIGH".
          const archiveId = randomUUID();
          memory.insertArchive(
            archiveId,
            `Completed tasks ${label}`,
            combined,
            tag,
            [],
            0.9,
            DIGEST_AGENT_ID,
          );
          memory.upsertEmbedding(archiveId, "archive", vec);
        }
        memory.db
          .query(
            `DELETE FROM tasks WHERE status = 'done'
               AND completed_at < unixepoch() - ?
               AND strftime('%Y-W%W', completed_at, 'unixepoch') = ?`,
          )
          .run(DONE_AGE_SECONDS, week);
      });
      pruned += tasks.length;
      log.info(`digest week=${label} ${existing ? "updated" : "created"} items=${tasks.length}`);
    } catch (err) {
      log.warn(`tx week=${label} failed: ${String(err)}`);
    }
  }

  const cancelled = memory.db
    .query(
      `DELETE FROM tasks WHERE status = 'cancelled'
         AND updated_at < unixepoch() - ?`,
    )
    .run(CANCELLED_AGE_SECONDS);

  return pruned + cancelled.changes;
}

function capFromHead(lines: string[], total: number): string {
  const full = lines.join("\n");
  if (full.length <= MAX_CONTENT_CHARS) return full;
  const prefixTemplate = (m: number) => `Completed ${total} tasks (showing first ${m}):\n`;
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const next = size + line.length + 1;
    if (next + prefixTemplate(kept.length + 1).length > MAX_CONTENT_CHARS) break;
    kept.push(line);
    size = next;
  }
  return prefixTemplate(kept.length) + kept.join("\n");
}

export function _capFromTailForTest(content: string): string {
  return capFromTail(content);
}

function capFromTail(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) return content;
  const lines = content.split("\n");
  const totalEst = lines.filter((l) => l.startsWith("- [")).length;
  const prefixTemplate = (m: number) =>
    `Completed ~${totalEst} tasks (showing most recent ${m}):\n`;
  const keptReverse: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const next = size + line.length + 1;
    if (next + prefixTemplate(keptReverse.length + 1).length > MAX_CONTENT_CHARS) break;
    keptReverse.push(line);
    size = next;
  }
  if (keptReverse.length === 0) {
    // Pathological case: a single line is itself > MAX_CONTENT_CHARS. Fall
    // back to a raw char truncation of the tail rather than losing the
    // entire digest.
    const headroom = MAX_CONTENT_CHARS - prefixTemplate(1).length;
    return prefixTemplate(1) + content.slice(-Math.max(0, headroom));
  }
  keptReverse.reverse();
  return prefixTemplate(keptReverse.length) + keptReverse.join("\n");
}
