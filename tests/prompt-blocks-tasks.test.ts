/**
 * Phase 2 — prompt-blocks/tasks.ts. Pure renderers over MemoryDB.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { MemoryDB } from "../src/db";
import {
  SCOPE_VISIBILITY,
  renderActiveTasks,
  renderTgStatus,
  fmtShortDate,
  safeTitle,
} from "../src/pipeline/agent-loop/prompt-blocks/tasks";

const DB_PATH = "data/test-prompt-blocks.db";

function freshDb(): MemoryDB {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${DB_PATH}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
  return new MemoryDB(DB_PATH);
}

describe("SCOPE_VISIBILITY", () => {
  test("global sees only global", () => {
    expect(SCOPE_VISIBILITY.global).toEqual(["global"]);
  });
  test("autonomous sees autonomous + global", () => {
    expect(SCOPE_VISIBILITY.autonomous).toEqual(["autonomous", "global"]);
  });
  test("free-agent sees free-agent + global", () => {
    expect(SCOPE_VISIBILITY["free-agent"]).toEqual(["free-agent", "global"]);
  });
  test("freelance isolated (no global)", () => {
    expect(SCOPE_VISIBILITY.freelance).toEqual(["freelance"]);
  });
  test("tg sees tg + global", () => {
    expect(SCOPE_VISIBILITY.tg).toEqual(["tg", "global"]);
  });
});

describe("fmtShortDate", () => {
  test("valid unix seconds → YYYY-MM-DD", () => {
    const ts = Math.floor(Date.UTC(2026, 3, 23) / 1000);
    expect(fmtShortDate(ts)).toBe("2026-04-23");
  });
  test("null → null", () => {
    expect(fmtShortDate(null)).toBeNull();
  });
  test("undefined → null", () => {
    expect(fmtShortDate(undefined)).toBeNull();
  });
  test("0 → null (guard)", () => {
    expect(fmtShortDate(0)).toBeNull();
  });
  test("NaN → null", () => {
    expect(fmtShortDate(Number.NaN)).toBeNull();
  });
});

describe("safeTitle", () => {
  test("passthrough short", () => {
    expect(safeTitle("hello")).toBe("hello");
  });
  test("collapse newlines", () => {
    expect(safeTitle("a\nb\r\nc")).toBe("a b c");
  });
  test("trim", () => {
    expect(safeTitle("  hi  ")).toBe("hi");
  });
  test("truncate >120 chars with ellipsis", () => {
    const long = "x".repeat(200);
    const out = safeTitle(long);
    expect(out.length).toBe(120);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("renderActiveTasks", () => {
  let memory: MemoryDB;
  beforeEach(() => {
    memory = freshDb();
  });
  afterEach(() => memory.close());

  test("empty all scopes → empty string", () => {
    expect(renderActiveTasks(memory, "global")).toBe("");
    expect(renderActiveTasks(memory, "autonomous")).toBe("");
  });

  test("single task rendered with icon + id6 + title", () => {
    const id = "abc123def456";
    memory.insertTask({
      id,
      title: "Fix bug",
      scope: "global",
    });
    const out = renderActiveTasks(memory, "global");
    expect(out).toContain("## Active tasks");
    expect(out).toContain("### global (1 active)");
    expect(out).toContain("📌 [abc123]");
    expect(out).toContain("Fix bug");
  });

  test("in_progress uses ⏳ icon", () => {
    const t = memory.insertTask({
      id: randomUUID(),
      title: "Working",
      scope: "global",
    });
    memory.transitionTask(t.id, "in_progress");
    const out = renderActiveTasks(memory, "global");
    expect(out).toContain("⏳");
  });

  test("priority>0 rendered, priority=0 omitted", () => {
    memory.insertTask({
      id: randomUUID(),
      title: "lo",
      scope: "global",
      priority: 0,
    });
    memory.insertTask({
      id: randomUUID(),
      title: "hi",
      scope: "global",
      priority: 7,
    });
    const out = renderActiveTasks(memory, "global");
    expect(out).toContain(" p7 ");
    expect(out).not.toMatch(/ p0 /);
  });

  test("due_at rendered in YYYY-MM-DD, null omitted", () => {
    const ts = Math.floor(Date.UTC(2026, 3, 23) / 1000);
    memory.insertTask({
      id: randomUUID(),
      title: "dated",
      scope: "global",
      due_at: ts,
    });
    memory.insertTask({
      id: randomUUID(),
      title: "undated",
      scope: "global",
    });
    const out = renderActiveTasks(memory, "global");
    expect(out).toContain("due=2026-04-23");
    expect(out).toMatch(/undated/);
  });

  test("overflow counter when >5 tasks in scope", () => {
    for (let i = 0; i < 7; i++) {
      memory.insertTask({
        id: randomUUID(),
        title: `t${i}`,
        scope: "global",
        priority: i, // higher priority first
      });
    }
    const out = renderActiveTasks(memory, "global");
    expect(out).toContain("### global (7 active)");
    expect(out).toContain("+2 more in this scope");
    expect(out).toContain('`task_list({scope:"global"})`');
  });

  test("autonomous sees autonomous + global subsections", () => {
    memory.insertTask({
      id: randomUUID(),
      title: "auto-1",
      scope: "autonomous",
    });
    memory.insertTask({
      id: randomUUID(),
      title: "glob-1",
      scope: "global",
    });
    const out = renderActiveTasks(memory, "autonomous");
    expect(out).toContain("### autonomous (1 active)");
    expect(out).toContain("### global (1 active)");
    expect(out).toContain("auto-1");
    expect(out).toContain("glob-1");
  });

  test("freelance does NOT include global", () => {
    memory.insertTask({
      id: randomUUID(),
      title: "fl-1",
      scope: "freelance",
    });
    memory.insertTask({
      id: randomUUID(),
      title: "glob-hidden",
      scope: "global",
    });
    const out = renderActiveTasks(memory, "freelance");
    expect(out).toContain("### freelance (1 active)");
    expect(out).not.toContain("### global");
    expect(out).not.toContain("glob-hidden");
  });

  test("scope empty with sibling having tasks → _пусто_ subsection", () => {
    memory.insertTask({
      id: randomUUID(),
      title: "only-glob",
      scope: "global",
    });
    const out = renderActiveTasks(memory, "autonomous");
    expect(out).toContain("### autonomous: _пусто_");
    expect(out).toContain("### global (1 active)");
  });

  test("title with newlines is collapsed", () => {
    memory.insertTask({
      id: randomUUID(),
      title: "multi\nline\ntitle",
      scope: "global",
    });
    const out = renderActiveTasks(memory, "global");
    expect(out).toContain("multi line title");
    expect(out).not.toContain("multi\nline");
  });
});

describe("renderTgStatus", () => {
  let memory: MemoryDB;
  beforeEach(() => {
    memory = freshDb();
  });
  afterEach(() => memory.close());

  test("no poll, no unread → empty string", () => {
    expect(renderTgStatus(memory)).toBe("");
  });

  test("no poll, unread>0 → 'Poller не запускался' block", () => {
    memory.insertTask({
      id: randomUUID(),
      title: "tg task",
      scope: "tg",
    });
    const out = renderTgStatus(memory);
    expect(out).toContain("## TG status");
    expect(out).toContain("Poller не запускался");
    expect(out).toContain("Unread DMs: 1");
  });

  test("fresh poll → normal block, no ⚠️", () => {
    const now = Math.floor(Date.now() / 1000);
    memory.upsertSchedulerState("tg.last_checked_at", String(now));
    const out = renderTgStatus(memory);
    expect(out).toContain("## TG status");
    expect(out).not.toContain("⚠️");
    expect(out).toMatch(/Last poll: \d+s ago/);
    expect(out).not.toContain("STALE");
  });

  test("stale >300s → ⚠️ + STALE marker", () => {
    const staleTs = Math.floor(Date.now() / 1000) - 400;
    memory.upsertSchedulerState("tg.last_checked_at", String(staleTs));
    const out = renderTgStatus(memory);
    expect(out).toContain("## TG status ⚠️");
    expect(out).toContain("STALE — poller dead?");
  });

  test("NaN value → treated as no-poll", () => {
    memory.upsertSchedulerState("tg.last_checked_at", "not-a-number");
    // no unread → empty
    expect(renderTgStatus(memory)).toBe("");
    // with unread → no-poll block
    memory.insertTask({
      id: randomUUID(),
      title: "tg",
      scope: "tg",
    });
    const out = renderTgStatus(memory);
    expect(out).toContain("Poller не запускался");
  });

  test("unread>0 → tg_gone hint", () => {
    const now = Math.floor(Date.now() / 1000);
    memory.upsertSchedulerState("tg.last_checked_at", String(now));
    memory.insertTask({
      id: randomUUID(),
      title: "tg",
      scope: "tg",
    });
    const out = renderTgStatus(memory);
    expect(out).toContain("tg_gone");
    expect(out).toContain("task_cancel");
  });

  test("unread=0 with fresh poll → no hint", () => {
    const now = Math.floor(Date.now() / 1000);
    memory.upsertSchedulerState("tg.last_checked_at", String(now));
    const out = renderTgStatus(memory);
    expect(out).not.toContain("tg_gone");
    expect(out).toContain("Unread DMs: 0");
  });

  test("future timestamp (clock skew) → age clamped to 0", () => {
    const future = Math.floor(Date.now() / 1000) + 100;
    memory.upsertSchedulerState("tg.last_checked_at", String(future));
    const out = renderTgStatus(memory);
    expect(out).toContain("Last poll: 0s ago");
    expect(out).not.toContain("⚠️");
  });
});
