import { Elysia } from "elysia";
import type { ModelRouter } from "../lib/model-router";

/** Virtual models exposed to VS Code. Will be resolved by Model Router later. */
const VIRTUAL_MODELS = [
  { id: "teamlead", name: "Лид (kimi-k2-thinking)" },
  { id: "coder", name: "Кодер (devstral-123b)" },
  { id: "critic", name: "Критик (qwen3-coder-480b)" },
  { id: "generalist", name: "Генералист (qwen3-coder-480b)" },
  { id: "flash", name: "Флэш (step-3.5-flash)" },
];

export function modelsRoute(router: ModelRouter) {
  return new Elysia().get("/v1/models", () => {
    return {
      object: "list" as const,
      data: VIRTUAL_MODELS.map((m) => ({
        id: m.id,
        object: "model" as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: "subbrain",
      })),
    };
  });
}
