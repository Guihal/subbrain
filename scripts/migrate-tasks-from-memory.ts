#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
/**
 * One-shot migration: pull task-like rows from shared_memory + layer2_context
 * into the `tasks` table (Phase-1 store). Per-row LLM classification decides
 * migrate vs keep; every migrate is logged to a JSONL audit trail so the
 * change can be rolled back via scripts/rollback-migration.ts.
 *
 *   bun run scripts/migrate-tasks-from-memory.ts           # dry-run (default)
 *   bun run scripts/migrate-tasks-from-memory.ts --apply   # actually mutate
 *
 * Dry-run prints a table of every candidate + classifier verdict; no DB or
 * filesystem side-effects. Apply wraps each migrate in a transaction:
 *   upsertTaskBySource(source="migrated:<table>:<id>", ...)
 *   + deleteShared|deleteContext(source id)
 *   + append JSON line to scripts/migration-log/tasks-YYYY-MM-DD.jsonl
 *
 * Idempotent: re-running after a successful migrate is a no-op because
 * `upsertTaskBySource` returns `skipped=true` for existing terminal rows
 * and the source row is already gone.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";
import { getMoscowDate } from "@subbrain/core/lib/clock";
import { logger } from "@subbrain/core/lib/logger";
import { createProviders } from "@subbrain/providers";
import { ModelRouter } from "@subbrain/core/lib/model-router";
import {
  type CandidateRow,
  type Classifier,
  type ClassifyResult,
  classifyCandidate,
  hasBlacklistTag,
  hasCompletedStatusTag,
  hasTaskTag,
} from "@subbrain/agent/pipeline/night-cycle/prune/tasks-classify";

const log = logger.child("migrate.tasks");

export interface MigrationOptions {
  apply: boolean;
  jsonlPath: string;
}

export interface MigrationSummary {
  total: number;
  migrated: number;
  kept: number;
  skipped: number;
  errors: number;
}

export interface JsonlEntry {
  source_table: "shared_memory" | "layer2_context";
  source_id: string;
  original_content: string;
  original_tags: string;
  original_category?: string;
  original_title?: string;
  original_agent_id?: string | null;
  new_task_id: string;
  ts: number;
}

export async function runMigration(
  memory: MemoryDB,
  classifier: Classifier,
  opts: MigrationOptions,
): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    total: 0,
    migrated: 0,
    kept: 0,
    skipped: 0,
    errors: 0,
  };
  const candidates = collectCandidates(memory);
  summary.total = candidates.length;

  if (!opts.apply) {
    console.log(
      "table           | id (first 8) | tags (first 40)                        | verdict",
    );
    for (const row of candidates) {
      let verdict: string;
      try {
        const result = await classifyCandidate(classifier, row);
        if (!result) {
          summary.errors += 1;
          verdict = "error: classify returned null";
        } else if (result.action === "keep") {
          summary.kept += 1;
          verdict = `keep: ${result.reason.slice(0, 60)}`;
        } else {
          summary.migrated += 1;
          verdict = `migrate: scope=${result.scope} title=${result.title.slice(0, 40)}`;
        }
      } catch (err) {
        summary.errors += 1;
        verdict = `error: ${(err as Error).message}`;
      }
      console.log(
        `${row.source_table.padEnd(15)} | ${row.id.slice(0, 8)} | ${row.tags.slice(0, 40).padEnd(40)} | ${verdict}`,
      );
    }
    return summary;
  }

  mkdirSync(opts.jsonlPath.replace(/\/[^/]+$/, ""), { recursive: true });

  for (const row of candidates) {
    let result: ClassifyResult | null;
    try {
      result = await classifyCandidate(classifier, row);
    } catch (err) {
      summary.errors += 1;
      log.warn(`classify row=${row.id.slice(0, 8)} failed: ${(err as Error).message}`);
      continue;
    }
    if (!result) {
      summary.errors += 1;
      continue;
    }
    if (result.action === "keep") {
      summary.kept += 1;
      continue;
    }

    const migratePayload = result;
    const source = `migrated:${row.source_table}:${row.id}`;
    const newTaskId = randomUUID();
    try {
      let created = false;
      memory.db.transaction(() => {
        const upsert = memory.upsertTaskBySource(
          source,
          {
            scope: migratePayload.scope,
            title: migratePayload.title,
            description: migratePayload.description,
            priority: migratePayload.priority,
          },
          newTaskId,
        );
        created = upsert.created;
        if (upsert.created) {
          if (row.source_table === "shared_memory") {
            memory.deleteShared(row.id);
          } else {
            memory.deleteContext(row.id);
            memory.deleteEmbedding(row.id);
          }
        }
      })();
      if (created) {
        const entry: JsonlEntry = {
          source_table: row.source_table,
          source_id: row.id,
          original_content: row.content,
          original_tags: row.tags,
          original_category: row.category ?? undefined,
          original_title: row.title ?? undefined,
          original_agent_id: row.agent_id ?? null,
          new_task_id: newTaskId,
          ts: Math.floor(Date.now() / 1000),
        };
        appendFileSync(opts.jsonlPath, `${JSON.stringify(entry)}\n`);
        summary.migrated += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (err) {
      summary.errors += 1;
      log.warn(`tx row=${row.id.slice(0, 8)} failed: ${(err as Error).message}`);
    }
  }

  return summary;
}

export function collectCandidates(memory: MemoryDB): CandidateRow[] {
  const out: CandidateRow[] = [];
  const shared = memory.db
    .query(`SELECT id, category, content, tags FROM shared_memory`)
    .all() as Array<{ id: string; category: string; content: string; tags: string }>;
  for (const r of shared) {
    if (!hasTaskTag(r.tags)) continue;
    if (hasBlacklistTag(r.tags)) continue;
    if (hasCompletedStatusTag(r.tags)) continue;
    out.push({
      id: r.id,
      source_table: "shared_memory",
      content: r.content,
      tags: r.tags,
      category: r.category,
    });
  }
  const context = memory.db
    .query(`SELECT id, title, content, tags, agent_id FROM layer2_context`)
    .all() as Array<{
    id: string;
    title: string;
    content: string;
    tags: string;
    agent_id: string | null;
  }>;
  for (const r of context) {
    if (!hasTaskTag(r.tags)) continue;
    if (hasBlacklistTag(r.tags)) continue;
    if (hasCompletedStatusTag(r.tags)) continue;
    out.push({
      id: r.id,
      source_table: "layer2_context",
      content: r.content,
      tags: r.tags,
      title: r.title,
      agent_id: r.agent_id,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const confirm = process.argv.includes("--confirm");
  const dbPath = process.env.DB_PATH ?? "data/subbrain.db";
  const isProd = dbPath.endsWith("subbrain.db") && !dbPath.includes("test");
  if (apply && isProd && !confirm) {
    console.error("migrate-tasks: --apply on prod DB requires --confirm");
    process.exit(1);
  }
  const jsonlPath = `scripts/migration-log/tasks-${getMoscowDate()}.jsonl`;

  const memory = new MemoryDB(dbPath);
  const providers = await createProviders();
  const classifier = new ModelRouter(providers);
  try {
    const summary = await runMigration(memory, classifier, { apply, jsonlPath });
    console.log("\nSummary:");
    console.log(`  total=${summary.total}`);
    console.log(`  migrated=${summary.migrated}`);
    console.log(`  kept=${summary.kept}`);
    console.log(`  skipped=${summary.skipped}`);
    console.log(`  errors=${summary.errors}`);
    if (apply) {
      console.log(`  jsonl=${jsonlPath}`);
    } else {
      console.log("  (dry-run; no DB or filesystem changes)");
    }
  } finally {
    memory.close();
  }
}

if (import.meta.main) {
  await main();
}
