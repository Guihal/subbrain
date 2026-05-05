#!/usr/bin/env bun
/**
 * Rollback a one-shot task migration by replaying its JSONL audit trail.
 *
 *   bun run scripts/rollback-migration.ts scripts/migration-log/tasks-YYYY-MM-DD.jsonl
 *
 * Per JSONL line:
 *   - restores the original shared_memory / layer2_context row (INSERT OR IGNORE
 *     so re-runs are safe if the source is already back)
 *   - deletes the migrated task by its new_task_id
 *
 * A missing / empty JSONL exits with a non-zero status. Parse errors on a
 * line are logged but do not abort the rollback (subsequent lines still
 * apply).
 */
import { existsSync, readFileSync } from "node:fs";
import type { MemoryDB } from "@subbrain/core/db";
import { MemoryDB as MemoryDBImpl } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { JsonlEntry } from "./migrate-tasks-from-memory";

const log = logger.child("migrate.rollback");

export interface RollbackResult {
  total: number;
  restored: number;
  skipped: number;
  errors: number;
}

export async function runRollback(memory: MemoryDB, jsonlPath: string): Promise<RollbackResult> {
  const result: RollbackResult = {
    total: 0,
    restored: 0,
    skipped: 0,
    errors: 0,
  };
  if (!existsSync(jsonlPath)) {
    throw new Error(`jsonl not found: ${jsonlPath}`);
  }
  const lines = readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  result.total = lines.length;

  for (const raw of lines) {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(raw) as JsonlEntry;
    } catch (err) {
      result.errors += 1;
      log.warn(`parse fail: ${(err as Error).message}`);
      continue;
    }
    try {
      let inserted = false;
      memory.db.transaction(() => {
        const table = entry.source_table === "shared_memory" ? "shared_memory" : "layer2_context";
        const exists = memory.db
          .query(`SELECT 1 AS x FROM ${table} WHERE id = ?`)
          .get(entry.source_id) as { x: number } | null;
        if (exists) {
          inserted = false;
        } else {
          if (entry.source_table === "shared_memory") {
            memory.db
              .query(
                `INSERT INTO shared_memory
                 (id, category, content, tags, source)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .run(
                entry.source_id,
                entry.original_category ?? "general",
                entry.original_content,
                entry.original_tags,
                "migration-rollback",
              );
          } else {
            memory.db
              .query(
                `INSERT INTO layer2_context
                 (id, title, content, tags, derived_from, agent_id)
                 VALUES (?, ?, ?, ?, '[]', ?)`,
              )
              .run(
                entry.source_id,
                entry.original_title ?? "",
                entry.original_content,
                entry.original_tags,
                entry.original_agent_id ?? null,
              );
          }
          inserted = true;
        }
        memory.deleteTask(entry.new_task_id);
      })();
      if (inserted) result.restored += 1;
      else result.skipped += 1;
    } catch (err) {
      result.errors += 1;
      log.warn(`tx fail: ${(err as Error).message}`);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const jsonlPath = process.argv[2];
  if (!jsonlPath) {
    console.error("Usage: bun run scripts/rollback-migration.ts <jsonl-path> [--confirm]");
    process.exit(1);
  }
  const dbPath = process.env.DB_PATH ?? "data/subbrain.db";
  const isProd = dbPath.endsWith("subbrain.db") && !dbPath.includes("test");
  if (isProd && !process.argv.includes("--confirm")) {
    console.error("rollback-migration: prod DB detected, pass --confirm to override");
    process.exit(1);
  }
  const memory = new MemoryDBImpl(dbPath);
  try {
    const result = await runRollback(memory, jsonlPath);
    console.log("Rollback summary:");
    console.log(`  total=${result.total}`);
    console.log(`  restored=${result.restored}`);
    console.log(`  skipped=${result.skipped}`);
    console.log(`  errors=${result.errors}`);
  } finally {
    memory.close();
  }
}

if (import.meta.main) {
  await main();
}
