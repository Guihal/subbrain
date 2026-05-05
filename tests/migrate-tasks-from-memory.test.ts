/**
 * Phase 5 — migration + rollback + stray-collection unit tests.
 *
 * No network: classifier is a fake that returns canned JSON per-call.
 * JSONL log is written to a tmp path outside scripts/migration-log/.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { type JsonlEntry, runMigration } from "../scripts/migrate-tasks-from-memory";
import { runRollback } from "../scripts/rollback-migration";
import { MemoryDB } from "../src/db";
import {
  collectStrayTasks,
  LAST_RUN_FOCUS_KEY,
} from "../src/pipeline/night-cycle/prune/stray-tasks";
import type { Classifier, ClassifyResult } from "../src/pipeline/night-cycle/prune/tasks-classify";
import {
  classifyCandidate,
  hasBlacklistTag,
  hasTaskTag,
} from "../src/pipeline/night-cycle/prune/tasks-classify";

const DB_PATH = "data/test-migrate-tasks.db";
const JSONL_DIR = "data/test-migrate-jsonl";
const JSONL_PATH = `${JSONL_DIR}/tasks.jsonl`;

function freshDb(): MemoryDB {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${DB_PATH}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
  if (existsSync(JSONL_DIR)) rmSync(JSONL_DIR, { recursive: true, force: true });
  return new MemoryDB(DB_PATH);
}

function makeClassifier(
  response: ClassifyResult | "malformed" | "missing-scope",
): Classifier & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    set calls(v) {
      state.calls = v;
    },
    async chat() {
      state.calls += 1;
      let content: string;
      if (response === "malformed") {
        content = "{not-json]";
      } else if (response === "missing-scope") {
        content = JSON.stringify({
          action: "migrate",
          title: "x",
          description: "",
          priority: 0,
          due_at: null,
        });
      } else {
        content = JSON.stringify(response);
      }
      return {
        id: "test",
        object: "chat.completion" as const,
        created: Date.now(),
        model: "mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant" as const, content },
            finish_reason: "stop",
          },
        ],
      };
    },
  };
}

afterAll(() => {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${DB_PATH}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
  if (existsSync(JSONL_DIR)) rmSync(JSONL_DIR, { recursive: true, force: true });
});

describe("classifyCandidate", () => {
  test("valid migrate JSON → migrate result", async () => {
    const classifier = makeClassifier({
      action: "migrate",
      scope: "global",
      title: "Write X",
      description: "details",
      priority: 3,
      due_at: null,
    });
    const r = await classifyCandidate(classifier, {
      id: "a",
      source_table: "shared_memory",
      content: "c",
      tags: "task",
    });
    expect(r?.action).toBe("migrate");
    if (r?.action === "migrate") {
      expect(r.scope).toBe("global");
      expect(r.title).toBe("Write X");
      expect(r.priority).toBe(3);
    }
  });

  test("keep JSON → keep result", async () => {
    const classifier = makeClassifier({
      action: "keep",
      reason: "it is a fact",
    });
    const r = await classifyCandidate(classifier, {
      id: "a",
      source_table: "shared_memory",
      content: "c",
      tags: "task",
    });
    expect(r?.action).toBe("keep");
  });

  test("malformed JSON → null", async () => {
    const classifier = makeClassifier("malformed");
    const r = await classifyCandidate(classifier, {
      id: "a",
      source_table: "shared_memory",
      content: "c",
      tags: "task",
    });
    expect(r).toBeNull();
  });

  test("migrate without scope → null", async () => {
    const classifier = makeClassifier("missing-scope");
    const r = await classifyCandidate(classifier, {
      id: "a",
      source_table: "shared_memory",
      content: "c",
      tags: "task",
    });
    expect(r).toBeNull();
  });
});

describe("tag helpers", () => {
  test("hasTaskTag: substring match, case-insensitive, Cyrillic", () => {
    expect(hasTaskTag("task,todo")).toBe(true);
    expect(hasTaskTag("TASK")).toBe(true);
    expect(hasTaskTag("дедлайн")).toBe(true);
    expect(hasTaskTag("architecture")).toBe(false);
    expect(hasTaskTag("")).toBe(false);
  });
  test("hasBlacklistTag: substring, case-insensitive", () => {
    expect(hasBlacklistTag("architecture")).toBe(true);
    expect(hasBlacklistTag("PATTERN")).toBe(true);
    expect(hasBlacklistTag("task")).toBe(false);
  });
});

describe("runMigration", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = freshDb();
  });

  function seedSharedTask(id: string): void {
    memory.insertShared(id, "general", "need to finish X by Friday", "task,todo");
  }

  test("dry-run: no DB mutation, no JSONL", async () => {
    const id = randomUUID();
    seedSharedTask(id);
    const classifier = makeClassifier({
      action: "migrate",
      scope: "global",
      title: "Finish X",
      description: "by friday",
      priority: 0,
      due_at: null,
    });
    const summary = await runMigration(memory, classifier, {
      apply: false,
      jsonlPath: JSONL_PATH,
    });
    expect(summary.total).toBe(1);
    expect(summary.migrated).toBe(1);
    // source row still present
    expect(memory.getShared(id)).not.toBeNull();
    // no task created
    const tasks = memory.listTasks({ limit: 10, offset: 0 });
    expect(tasks.total).toBe(0);
    expect(existsSync(JSONL_PATH)).toBeFalse();
  });

  test("apply: tx creates task, deletes source, appends JSONL", async () => {
    const id = randomUUID();
    seedSharedTask(id);
    const classifier = makeClassifier({
      action: "migrate",
      scope: "autonomous",
      title: "Finish X",
      description: "by friday",
      priority: 2,
      due_at: null,
    });
    const summary = await runMigration(memory, classifier, {
      apply: true,
      jsonlPath: JSONL_PATH,
    });
    expect(summary.migrated).toBe(1);
    expect(memory.getShared(id)).toBeNull();
    const tasks = memory.listTasks({ limit: 10, offset: 0 });
    expect(tasks.total).toBe(1);
    expect(tasks.items[0].title).toBe("Finish X");
    expect(tasks.items[0].scope).toBe("autonomous");
    const jsonl = readFileSync(JSONL_PATH, "utf8").trim();
    const entry = JSON.parse(jsonl) as JsonlEntry;
    expect(entry.source_table).toBe("shared_memory");
    expect(entry.source_id).toBe(id);
    expect(entry.new_task_id).toBe(tasks.items[0].id);
  });

  test("re-run same source: upsertBySource skipped, no dup, no JSONL line", async () => {
    const id = randomUUID();
    seedSharedTask(id);
    const classifier = makeClassifier({
      action: "migrate",
      scope: "global",
      title: "X",
      description: "",
      priority: 0,
      due_at: null,
    });
    await runMigration(memory, classifier, {
      apply: true,
      jsonlPath: JSONL_PATH,
    });
    const firstLines = readFileSync(JSONL_PATH, "utf8").split("\n").filter(Boolean).length;
    // mark task done so it stays in terminal state; re-run with same source id
    const created = memory.listTasks({ limit: 1, offset: 0 }).items[0];
    memory.transitionTask(created.id, "done");
    // re-seed source (simulating rerun on fresh-looking row with same content)
    memory.insertShared(id, "general", "c", "task");
    const summary = await runMigration(memory, classifier, {
      apply: true,
      jsonlPath: JSONL_PATH,
    });
    expect(summary.migrated).toBe(0);
    expect(summary.skipped).toBe(1);
    const secondLines = readFileSync(JSONL_PATH, "utf8").split("\n").filter(Boolean).length;
    expect(secondLines).toBe(firstLines);
  });
});

describe("runRollback", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = freshDb();
  });

  test("restores shared row + deletes migrated task", async () => {
    const sharedId = randomUUID();
    memory.insertShared(sharedId, "general", "finish X", "task");
    const classifier = makeClassifier({
      action: "migrate",
      scope: "global",
      title: "Finish X",
      description: "",
      priority: 0,
      due_at: null,
    });
    await runMigration(memory, classifier, {
      apply: true,
      jsonlPath: JSONL_PATH,
    });
    expect(memory.getShared(sharedId)).toBeNull();
    const taskId = memory.listTasks({ limit: 1, offset: 0 }).items[0].id;

    const res = await runRollback(memory, JSONL_PATH);
    expect(res.restored).toBe(1);
    expect(memory.getShared(sharedId)).not.toBeNull();
    expect(memory.getTask(taskId)).toBeNull();
  });

  test("idempotent: re-running skips existing", async () => {
    const sharedId = randomUUID();
    memory.insertShared(sharedId, "general", "finish X", "task");
    const classifier = makeClassifier({
      action: "migrate",
      scope: "global",
      title: "Finish X",
      description: "",
      priority: 0,
      due_at: null,
    });
    await runMigration(memory, classifier, {
      apply: true,
      jsonlPath: JSONL_PATH,
    });
    await runRollback(memory, JSONL_PATH);
    const res2 = await runRollback(memory, JSONL_PATH);
    expect(res2.restored).toBe(0);
    expect(res2.skipped).toBe(1);
  });
});

describe("collectStrayTasks focus-key state", () => {
  let memory: MemoryDB;

  beforeEach(() => {
    memory = freshDb();
  });

  test("first run has no key → uses 7d window; setFocus after", async () => {
    const now = Math.floor(Date.now() / 1000);
    const id = randomUUID();
    memory.insertShared(id, "general", "do X", "task");
    memory.db.query(`UPDATE shared_memory SET created_at=? WHERE id=?`).run(now - 3 * 86400, id);
    const classifier = makeClassifier({
      action: "migrate",
      scope: "global",
      title: "Do X",
      description: "",
      priority: 0,
      due_at: null,
    });
    const migrated = await collectStrayTasks(memory, classifier);
    expect(migrated).toBe(1);
    const stamped = memory.getFocus(LAST_RUN_FOCUS_KEY);
    expect(stamped).not.toBeNull();
    expect(Number(stamped)).toBeGreaterThan(now - 5);
  });

  test("subsequent run honors last_run_at window — rows before it are skipped", async () => {
    const now = Math.floor(Date.now() / 1000);
    memory.setFocus(LAST_RUN_FOCUS_KEY, String(now - 3600));
    const id = randomUUID();
    memory.insertShared(id, "general", "do X", "task");
    memory.db.query(`UPDATE shared_memory SET created_at=? WHERE id=?`).run(now - 7200, id);
    const classifier = makeClassifier({
      action: "migrate",
      scope: "global",
      title: "X",
      description: "",
      priority: 0,
      due_at: null,
    });
    const migrated = await collectStrayTasks(memory, classifier);
    expect(migrated).toBe(0);
    expect(classifier.calls).toBe(0);
  });

  test("blacklist tag excludes candidate", async () => {
    const id = randomUUID();
    memory.insertShared(id, "general", "arch doc", "task,architecture");
    const classifier = makeClassifier({
      action: "migrate",
      scope: "global",
      title: "X",
      description: "",
      priority: 0,
      due_at: null,
    });
    const migrated = await collectStrayTasks(memory, classifier);
    expect(migrated).toBe(0);
    expect(classifier.calls).toBe(0);
  });

  test("completed-status tag excludes candidate (task,done)", async () => {
    const id = randomUUID();
    memory.insertShared(id, "general", "finished X", "task,done");
    const classifier = makeClassifier({
      action: "migrate",
      scope: "global",
      title: "X",
      description: "",
      priority: 0,
      due_at: null,
    });
    const migrated = await collectStrayTasks(memory, classifier);
    expect(migrated).toBe(0);
    expect(classifier.calls).toBe(0);
  });

  test("focus key NOT advanced when MAX_PER_CYCLE cap hits", async () => {
    // Seed 22 candidates — above the cap of 20. The cap is hardcoded inside
    // stray-tasks.ts, so we rely on that constant rather than parameterize.
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 22; i++) {
      const id = randomUUID();
      memory.insertShared(id, "general", `do ${i}`, "task");
      memory.db.query(`UPDATE shared_memory SET created_at=? WHERE id=?`).run(now - 100 - i, id);
    }
    const classifier = makeClassifier({
      action: "keep",
      reason: "not a task",
    });
    await collectStrayTasks(memory, classifier);
    const stamped = memory.getFocus(LAST_RUN_FOCUS_KEY);
    expect(stamped).toBeNull();
  });
});
