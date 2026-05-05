/** M-11 sleep-time focus block rewriter — see plan §Тесты. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { runFocusRewrite } from "@subbrain/agent/pipeline/night-cycle/steps/focus-rewrite";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test-mem11-focus-rewrite.db";
const ENV_KEYS = [
  "NIGHT_CYCLE_FOCUS_REWRITE_ENABLED",
  "FOCUS_REWRITE_TOP_K",
  "FOCUS_REWRITE_MAX_LEN",
  "NIGHT_CYCLE_MODEL",
] as const;

function cleanup(): void {
  for (const ext of ["", "-shm", "-wal"]) {
    const p = `${TEST_DB}${ext}`;
    if (existsSync(p)) unlinkSync(p);
  }
}

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

interface MockRouterOpts {
  reply?: string | ((args: { key: string; current: string }) => string);
  fail?: boolean;
}

function makeRouter(opts: MockRouterOpts = {}): any {
  const router: any = {
    chatCalls: 0,
    lastMessages: null as any,
    chat: async (_model: string, params: any) => {
      router.chatCalls++;
      router.lastMessages = params?.messages;
      if (opts.fail) throw new Error("simulated llm failure");
      // Pull current value from the user message — the prompt embeds it as
      // `current: <value>` so tests can echo / mutate it.
      const userMsg: string = params?.messages?.find((m: any) => m.role === "user")?.content ?? "";
      const keyMatch = userMsg.match(/^key: (.+)$/m);
      const currMatch = userMsg.match(/^current: ([\s\S]+?)\n\ntop_shared:/m);
      const key = keyMatch?.[1] ?? "";
      const current = currMatch?.[1] ?? "";
      const reply = opts.reply ?? "echoed";
      const out = typeof reply === "function" ? reply({ key, current }) : reply;
      return { choices: [{ message: { content: out } }] };
    },
  };
  return router;
}

function seedShared(
  memory: MemoryDB,
  category: string,
  content: string,
  kind: "persona" | "semantic" = "semantic",
): string {
  const id = `s-${category}-${Math.random().toString(36).slice(2, 8)}`;
  memory.db
    .query(
      `INSERT INTO shared_memory (id, category, content, tags, kind, status, salience, access_count)
       VALUES (?, ?, ?, '', ?, 'active', 0.7, 3)`,
    )
    .run(id, category, content, kind);
  return id;
}

describe("M-11 sleep-time focus block rewriter", () => {
  let memory: MemoryDB;
  let envSnap: Record<string, string | undefined>;

  beforeAll(() => {
    cleanup();
    envSnap = snapshotEnv();
  });

  afterAll(() => {
    restoreEnv(envSnap);
    cleanup();
  });

  beforeEach(() => {
    if (memory) memory.close();
    cleanup();
    memory = new MemoryDB(TEST_DB);
    for (const k of ENV_KEYS) delete process.env[k];
  });

  test("disabled by default → zeros, no LLM call", async () => {
    memory.setFocus("project.goal", "Ship Subbrain v1");
    seedShared(memory, "preference", "User likes Bun runtime", "persona");
    const router = makeRouter({ reply: "MUTATED" });
    const r = await runFocusRewrite({ memory, router });
    expect(r).toEqual({ rewritten: 0, skipped: 0, errors: 0 });
    expect(router.chatCalls).toBe(0);
    expect(memory.getAllShadowFocus()).toEqual({});
  });

  test("enabled but empty editable focus → zeros", async () => {
    process.env.NIGHT_CYCLE_FOCUS_REWRITE_ENABLED = "true";
    // PROTECTED keys only — must be filtered out by the step.
    memory.setFocus("night_cycle_last_processed_id", "42");
    memory.setFocus("tasks.state", "{}");
    seedShared(memory, "preference", "User likes Hyprland", "persona");
    const router = makeRouter({ reply: "MUTATED" });
    const r = await runFocusRewrite({ memory, router });
    expect(r).toEqual({ rewritten: 0, skipped: 0, errors: 0 });
    expect(router.chatCalls).toBe(0);
    expect(memory.getAllShadowFocus()).toEqual({});
  });

  test("enabled but no shared memos → zeros", async () => {
    process.env.NIGHT_CYCLE_FOCUS_REWRITE_ENABLED = "true";
    memory.setFocus("project.goal", "Ship Subbrain v1");
    const router = makeRouter({ reply: "MUTATED" });
    const r = await runFocusRewrite({ memory, router });
    expect(r).toEqual({ rewritten: 0, skipped: 0, errors: 0 });
    expect(router.chatCalls).toBe(0);
    expect(memory.getAllShadowFocus()).toEqual({});
  });

  test("happy-path → shadow row written, rewritten=1", async () => {
    process.env.NIGHT_CYCLE_FOCUS_REWRITE_ENABLED = "true";
    memory.setFocus("project.goal", "Ship Subbrain v1");
    for (let i = 0; i < 5; i++) {
      seedShared(memory, "preference", `Persona fact ${i}`, "persona");
    }
    const router = makeRouter({
      reply: "Ship Subbrain v1 — current top facts: Bun runtime, Hyprland.",
    });
    const r = await runFocusRewrite({ memory, router });
    expect(r.rewritten).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.errors).toBe(0);
    expect(router.chatCalls).toBe(1);
    expect(memory.getShadowFocus("project.goal")).toContain("Bun runtime");
  });

  test("real focus untouched on happy-path", async () => {
    process.env.NIGHT_CYCLE_FOCUS_REWRITE_ENABLED = "true";
    const oldValue = "Ship Subbrain v1";
    memory.setFocus("project.goal", oldValue);
    for (let i = 0; i < 3; i++) {
      seedShared(memory, "preference", `Persona ${i}`, "persona");
    }
    const newValue = "Updated synthesised goal";
    const router = makeRouter({ reply: newValue });
    const r = await runFocusRewrite({ memory, router });
    expect(r.rewritten).toBe(1);
    expect(memory.getFocus("project.goal")).toBe(oldValue);
    expect(memory.getShadowFocus("project.goal")).toBe(newValue);
  });

  test("protected keys skipped — only editable keys reach LLM", async () => {
    process.env.NIGHT_CYCLE_FOCUS_REWRITE_ENABLED = "true";
    memory.setFocus("night_cycle_last_processed_id", "100"); // protected
    memory.setFocus("tasks.state", "{}"); // protected
    memory.setFocus("project.goal", "editable goal"); // only this should rewrite
    seedShared(memory, "preference", "Persona fact", "persona");
    const seenKeys: string[] = [];
    const router = makeRouter({
      reply: ({ key }) => {
        seenKeys.push(key);
        return `rewritten for ${key}`;
      },
    });
    const r = await runFocusRewrite({ memory, router });
    expect(r.rewritten).toBe(1);
    expect(router.chatCalls).toBe(1);
    expect(seenKeys).toEqual(["project.goal"]);
    expect(memory.getShadowFocus("night_cycle_last_processed_id")).toBeNull();
    expect(memory.getShadowFocus("tasks.state")).toBeNull();
    expect(memory.getShadowFocus("project.goal")).toBe("rewritten for project.goal");
  });

  test("LLM echoes current value → skipped++", async () => {
    process.env.NIGHT_CYCLE_FOCUS_REWRITE_ENABLED = "true";
    memory.setFocus("project.goal", "Ship Subbrain v1");
    seedShared(memory, "preference", "Persona fact", "persona");
    const router = makeRouter({
      reply: ({ current }) => current,
    });
    const r = await runFocusRewrite({ memory, router });
    expect(r.rewritten).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.errors).toBe(0);
    expect(memory.getShadowFocus("project.goal")).toBeNull();
  });

  test("LLM exceeds MAX_FOCUS_LEN → skipped++ (no truncation)", async () => {
    process.env.NIGHT_CYCLE_FOCUS_REWRITE_ENABLED = "true";
    memory.setFocus("project.goal", "Ship Subbrain v1");
    seedShared(memory, "preference", "Persona fact", "persona");
    const huge = "x".repeat(1000);
    const router = makeRouter({ reply: huge });
    const r = await runFocusRewrite({ memory, router });
    expect(r.rewritten).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.errors).toBe(0);
    expect(memory.getShadowFocus("project.goal")).toBeNull();
  });

  test("LLM throws → errors++, step does not throw", async () => {
    process.env.NIGHT_CYCLE_FOCUS_REWRITE_ENABLED = "true";
    memory.setFocus("project.goal", "Ship Subbrain v1");
    seedShared(memory, "preference", "Persona fact", "persona");
    const router = makeRouter({ fail: true });
    const r = await runFocusRewrite({ memory, router });
    expect(r.rewritten).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.errors).toBe(1);
    expect(memory.getShadowFocus("project.goal")).toBeNull();
  });
});
