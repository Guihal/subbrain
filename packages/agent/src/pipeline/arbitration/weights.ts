/**
 * Specialist weights per task category + display-name lookup.
 * Pure data + helpers — no I/O.
 */

export type TaskCategory = "code" | "architecture" | "review" | "reasoning";

/** Initial weights: [code, architecture, review, reasoning] */
export const DEFAULT_WEIGHTS: Record<string, Record<TaskCategory, number>> = {
  coder: { code: 1.5, architecture: 0.8, review: 1.0, reasoning: 0.7 },
  critic: { code: 0.8, architecture: 1.0, review: 1.5, reasoning: 1.5 },
  generalist: { code: 1.0, architecture: 1.3, review: 1.0, reasoning: 1.0 },
  chaos: { code: 0.5, architecture: 1.4, review: 0.6, reasoning: 1.2 },
};

export function getWeight(role: string, category: TaskCategory): number {
  return DEFAULT_WEIGHTS[role]?.[category] ?? 1.0;
}

export function roleDisplayName(role: string): string {
  if (role === "coder") return "Кодер";
  if (role === "critic") return "Критик";
  if (role === "generalist") return "Генералист";
  if (role === "chaos") return "Хаос";
  return role;
}
