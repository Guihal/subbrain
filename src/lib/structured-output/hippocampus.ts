import type { HippocampusWrite, TaskAdd } from "../../baml_client";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseHippocampusWrite(raw: unknown): Result<HippocampusWrite> {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "expected object" };
  }
  const r = raw as Record<string, unknown>;

  const layer = String(r.layer || "context") === "shared" ? "shared" : "context";
  const category = String(r.category || "fact").slice(0, 64);
  const content = String(r.content || "").trim();
  const tags = String(r.tags || "");

  const rawConf = r.confidence;
  if (typeof rawConf !== "number" || !Number.isFinite(rawConf)) {
    return { ok: false, error: "confidence required (number 0..1)" };
  }
  if (!content) return { ok: false, error: "empty content" };
  const confidence = Math.min(1, Math.max(0, rawConf));

  const rawExp = r.expires_at;
  const expires_at: number | null | undefined =
    rawExp === null ? null : typeof rawExp === "number" ? rawExp : undefined;

  const supersedes = Array.isArray(r.supersedes)
    ? (r.supersedes as unknown[]).filter((s): s is string => typeof s === "string")
    : undefined;

  const value: HippocampusWrite = {
    layer,
    category,
    content,
    tags,
    confidence,
    expires_at,
    supersedes,
  };
  return { ok: true, value };
}

function mapPriority(p: "low" | "normal" | "high"): number {
  switch (p) {
    case "low":
      return 2;
    case "normal":
      return 5;
    case "high":
      return 8;
  }
}

export function parseTaskAdd(raw: unknown): Result<TaskAdd> {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "expected object" };
  }
  const r = raw as Record<string, unknown>;

  const title = String(r.title || "").trim();
  if (!title) return { ok: false, error: "title required" };

  const description =
    r.description === null || r.description === undefined ? undefined : String(r.description);

  const rawPriority = r.priority;
  if (rawPriority !== "low" && rawPriority !== "normal" && rawPriority !== "high") {
    return { ok: false, error: "priority must be low|normal|high" };
  }
  const priority = rawPriority;

  const rawDue = r.due_at;
  const due_at: number | null | undefined =
    rawDue === null ? null : typeof rawDue === "number" ? rawDue : undefined;

  const tags = r.tags === null || r.tags === undefined ? undefined : String(r.tags);

  const value: TaskAdd = { title, description, priority, due_at, tags };
  return { ok: true, value };
}

export type { HippocampusWrite, TaskAdd };

/** Runtime integer priority for task_add tool calls (maps BAML enum to codebase int). */
export function taskAddPriorityInt(p: TaskAdd["priority"]): number {
  return mapPriority(p);
}
