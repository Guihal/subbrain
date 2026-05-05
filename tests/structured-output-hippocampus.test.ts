import { describe, expect, test } from "bun:test";
import {
  parseHippocampusWrite,
  parseTaskAdd,
  taskAddPriorityInt,
} from "../src/lib/structured-output";

describe("parseHippocampusWrite", () => {
  test("valid shared write", () => {
    const r = parseHippocampusWrite({
      layer: "shared",
      category: "preference",
      content: "User prefers dark mode",
      tags: "ui,theme",
      confidence: 0.95,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.layer).toBe("shared");
    expect(r.value.category).toBe("preference");
    expect(r.value.confidence).toBe(0.95);
  });

  test("valid context write with expires_at", () => {
    const r = parseHippocampusWrite({
      layer: "context",
      category: "decision",
      content: "Use PostgreSQL for new feature",
      tags: "",
      confidence: 0.85,
      expires_at: 1_700_000_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expires_at).toBe(1_700_000_000);
  });

  test("valid write with supersedes", () => {
    const r = parseHippocampusWrite({
      layer: "shared",
      category: "goal",
      content: "Updated goal",
      tags: "",
      confidence: 0.9,
      supersedes: ["old-id-1", "old-id-2"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.supersedes).toEqual(["old-id-1", "old-id-2"]);
  });

  test("rejects missing confidence", () => {
    const r = parseHippocampusWrite({
      layer: "shared",
      category: "fact",
      content: "Something",
      tags: "",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("confidence");
  });

  test("rejects empty content", () => {
    const r = parseHippocampusWrite({
      layer: "shared",
      category: "fact",
      content: "   ",
      tags: "",
      confidence: 0.5,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("empty content");
  });
});

describe("parseTaskAdd", () => {
  test("valid task with normal priority", () => {
    const r = parseTaskAdd({
      title: "Fix auth bug",
      description: "Token expiry mishandled",
      priority: "normal",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe("Fix auth bug");
    expect(r.value.priority).toBe("normal");
  });

  test("valid task with high priority and due_at", () => {
    const r = parseTaskAdd({
      title: "Deploy hotfix",
      priority: "high",
      due_at: 1_700_000_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.priority).toBe("high");
    expect(r.value.due_at).toBe(1_700_000_000);
  });

  test("valid minimal task", () => {
    const r = parseTaskAdd({ title: "Refactor tests", priority: "low" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe("Refactor tests");
    expect(r.value.priority).toBe("low");
  });

  test("rejects missing title", () => {
    const r = parseTaskAdd({ priority: "normal" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("title");
  });

  test("rejects invalid priority", () => {
    const r = parseTaskAdd({ title: "X", priority: "urgent" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("priority");
  });
});

describe("taskAddPriorityInt", () => {
  test("maps enum to int", () => {
    expect(taskAddPriorityInt("low")).toBe(2);
    expect(taskAddPriorityInt("normal")).toBe(5);
    expect(taskAddPriorityInt("high")).toBe(8);
  });
});
