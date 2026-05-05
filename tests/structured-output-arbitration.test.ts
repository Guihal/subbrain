import { describe, expect, test } from "bun:test";
import { parseArbitrationSynthesis } from "@subbrain/agent/lib/structured-output";

describe("parseArbitrationSynthesis", () => {
  test("single fenced block", () => {
    const r = parseArbitrationSynthesis(
      '```json\n{"synthesis":"use REST","rationale":"simple","top_roles":["coder"]}\n```',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.synthesis).toBe("use REST");
    expect(r.value.top_roles).toEqual(["coder"]);
  });

  test("fence with leading prose", () => {
    const r = parseArbitrationSynthesis(
      'Here is the result:\n```json\n{"synthesis":"pick A","rationale":"fast","top_roles":["coder","generalist"]}\n```',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.synthesis).toBe("pick A");
    expect(r.value.top_roles).toEqual(["coder", "generalist"]);
  });

  test("top_roles with 3 entries", () => {
    const r = parseArbitrationSynthesis(
      '```json\n{"synthesis":"mixed","rationale":"none","top_roles":["coder","critic","chaos"]}\n```',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.top_roles).toEqual(["coder", "critic", "chaos"]);
  });

  test("no fence at all", () => {
    const r = parseArbitrationSynthesis("plain prose without json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no json block");
  });

  test("invalid JSON inside fence", () => {
    const r = parseArbitrationSynthesis("```json\n{broken\n```");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no json block");
  });

  test("missing top_roles field", () => {
    const r = parseArbitrationSynthesis('```json\n{"synthesis":"ok","rationale":"ok"}\n```');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.top_roles).toEqual([]);
  });
});
