/**
 * F-2: hardcoded-facts validator rejects code-tool bodies that embed frozen
 * client snapshots (имена, chat_ids, overdue_hours, dates). 0 matches → ok;
 * 1 → warn (accept); ≥2 distinct → reject.
 *
 * See docs/tasks/code-tools-poisoning-fix.md.
 */
import { describe, test, expect } from "bun:test";
import {
  checkHardcodedFacts,
  applyCodeToolGuards,
} from "../src/pipeline/agent-loop/code-tools/code-tool-validators";

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
} as const;

describe("checkHardcodedFacts (F-2)", () => {
  test("clean code → severity ok, matched empty", () => {
    const code = `export default async (i) => fetch('/v1/x').then(r=>r.json())`;
    const r = checkHardcodedFacts(code);
    expect(r.severity).toBe("ok");
    expect(r.matched).toEqual([]);
  });

  test("bare numbers (no key) → no false-positive", () => {
    const code = `export default async () => { const max = 1000; return max + 42; }`;
    const r = checkHardcodedFacts(code);
    expect(r.severity).toBe("ok");
  });

  test("1 match (person name only) → warn, single label", () => {
    const code = `export default async () => 'Артём готов'`;
    const r = checkHardcodedFacts(code);
    expect(r.severity).toBe("warn");
    expect(r.matched).toEqual(["person-name"]);
  });

  test("2 matches → reject with both labels", () => {
    const code = `const c = { name: 'Артём', chat_id: 1755145821 };`;
    const r = checkHardcodedFacts(code);
    expect(r.severity).toBe("reject");
    expect(r.matched).toContain("person-name");
    expect(r.matched).toContain("tg-chat-id-literal");
  });

  test("real overdue_reminder snapshot → reject, ≥3 labels", () => {
    const code = `
      const critical = [
        { name: "Артём", chat_id: "1755145821", overdue_hours: 18,
          lastAction: "24.04 10:14 окей" },
      ];
    `;
    const r = checkHardcodedFacts(code);
    expect(r.severity).toBe("reject");
    expect(r.matched.length).toBeGreaterThanOrEqual(3);
    expect(r.matched).toContain("person-name");
    expect(r.matched).toContain("overdue-hours-literal");
  });

  test("urgency emoji + key → match", () => {
    const code = `const x = { urgency: "🔴 critical" };`;
    const r = checkHardcodedFacts(code);
    expect(r.matched).toContain("urgency-emoji-literal");
  });

  test("ddmm date in deadline value → match", () => {
    const code = `const t = { deadline: "27.04.2026" };`;
    const r = checkHardcodedFacts(code);
    expect(r.matched).toContain("ddmm-date-literal");
  });
});

describe("applyCodeToolGuards (F-2 + sandbox)", () => {
  test("clean code → null (pass)", () => {
    const code = `export default async (i) => i.toUpperCase()`;
    expect(applyCodeToolGuards(code, "ok-tool", noopLog as never)).toBeNull();
  });

  test("sandbox-forbidden (require) → guardErr with sandbox_violation", () => {
    const code = `const fs = require('fs');`;
    const err = applyCodeToolGuards(code, "bad", noopLog as never);
    expect(err).not.toBeNull();
    expect(err?.error).toContain("sandbox_violation");
  });

  test("hardcoded facts ≥2 → guardErr with hardcoded_facts code", () => {
    const code = `const c = { name: 'Александр', chat_id: 534632085 };`;
    const err = applyCodeToolGuards(code, "bad", noopLog as never);
    expect(err).not.toBeNull();
    expect(err?.error).toContain("hardcoded_facts");
    expect(err?.error).toContain("person-name");
  });

  test("1 match → null (warn-and-accept)", () => {
    const code = `export default async () => 'hello Дмитрий'`;
    let warned = false;
    const log = { ...noopLog, warn: () => { warned = true; } };
    const err = applyCodeToolGuards(code, "warn-tool", log as never);
    expect(err).toBeNull();
    expect(warned).toBe(true);
  });
});
