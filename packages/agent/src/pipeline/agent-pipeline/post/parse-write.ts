import type { WriteSharedArgs } from "./extractors";

type ParsedWrite =
  | { ok: true; layer: "shared" | "context"; args: WriteSharedArgs }
  | { ok: false; error: string };

export function parseMemoryWriteArgs(raw: Record<string, unknown>): ParsedWrite {
  const layer = String(raw.layer || "context") === "shared" ? "shared" : "context";
  const category = String(raw.category || "fact").slice(0, 64);
  const content = String(raw.content || "").trim();
  const tags = String(raw.tags || "");
  const rawConf = raw.confidence;
  if (typeof rawConf !== "number" || !Number.isFinite(rawConf)) {
    return { ok: false, error: "confidence required (number 0..1)" };
  }
  if (!content) return { ok: false, error: "empty content" };
  const confidence = Math.min(1, Math.max(0, rawConf));
  const rawExp = raw.expires_at;
  const expires_at: number | null | undefined =
    rawExp === null ? null : typeof rawExp === "number" ? rawExp : undefined;
  const supersedes = Array.isArray(raw.supersedes)
    ? (raw.supersedes as unknown[]).filter((s): s is string => typeof s === "string")
    : undefined;
  return {
    ok: true,
    layer,
    args: { category, content, tags, confidence, expires_at, supersedes },
  };
}

export const NUDGE_NO_TOOL =
  "[Системная метка] Ответ текстом не сохранится в память. Используй memory_write/task_add для записи или done для завершения.";
