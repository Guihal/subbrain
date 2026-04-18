import { Elysia } from "elysia";
import type { ModelRouter } from "../lib/model-router";

/** Virtual models exposed to VS Code. Will be resolved by Model Router later. */
const VIRTUAL_MODELS = [
  { id: "teamlead", name: "Лид (Kimi K2 Thinking)" },
  { id: "coder", name: "Кодер (Qwen3 Coder 480B)" },
  { id: "critic", name: "Критик (Devstral 123B)" },
  { id: "generalist", name: "Генералист (Mistral Large 3 675B)" },
  { id: "flash", name: "Флэш (Step 3.5 Flash)" },
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
