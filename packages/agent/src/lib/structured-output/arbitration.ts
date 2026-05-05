import type { ArbitrationSynthesis as BamlArbitrationSynthesis } from "../../baml_client";

export type { BamlArbitrationSynthesis as ArbitrationSynthesis };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseArbitrationSynthesis(raw: string): Result<BamlArbitrationSynthesis> {
  const fence = raw.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonText = fence ? fence[1]!.trim() : raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "no json block" };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, error: "expected object" };
  }

  const r = parsed as Record<string, unknown>;

  const synthesis = typeof r.synthesis === "string" ? r.synthesis : "";
  const rationale = typeof r.rationale === "string" ? r.rationale : "";

  const rawTop = r.top_roles;
  const top_roles = Array.isArray(rawTop)
    ? (rawTop as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  if (!synthesis) {
    return { ok: false, error: "synthesis required" };
  }

  const value: BamlArbitrationSynthesis = { synthesis, rationale, top_roles };
  return { ok: true, value };
}
