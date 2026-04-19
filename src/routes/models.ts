import { Elysia } from "elysia";
import type { ModelRouter } from "../lib/model-router";
import { MODEL_MAP } from "../lib/model-map";

const ROLE_LABELS: Record<string, string> = {
  teamlead: "Лид",
  coder: "Кодер",
  critic: "Критик",
  generalist: "Генералист",
  chaos: "Хаос",
  flash: "Флэш",
};

/** Pretty-print model ID: "anthropic/claude-sonnet-4.6" → "Claude Sonnet 4.6" */
function prettyModel(id: string): string {
  const raw = id.includes("/") ? id.split("/").pop()! : id;
  return raw.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function modelsRoute(router: ModelRouter) {
  return new Elysia().get("/v1/models", () => {
    return {
      object: "list" as const,
      data: Object.entries(MODEL_MAP).map(([role, route]) => ({
        id: role,
        object: "model" as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: "subbrain",
        name: `${ROLE_LABELS[role] || role} (${prettyModel(route.primary)})`,
        // Extra metadata for frontend/TG
        label: ROLE_LABELS[role] || role,
        description: prettyModel(route.primary),
      })),
    };
  });
}
