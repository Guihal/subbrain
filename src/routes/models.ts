import { Elysia } from "elysia";
import type { ModelRouter } from "../lib/model-router";

/** Virtual models exposed to VS Code. Will be resolved by Model Router later. */
const VIRTUAL_MODELS = [
  { id: "teamlead", name: "Лид (Kimi K2.5)" },
  { id: "coder", name: "Кодер (Elephant Alpha)" },
  { id: "critic", name: "Критик (Nemotron 3 Super)" },
  { id: "generalist", name: "Генералист (MiniMax M2.5)" },
  { id: "flash", name: "Флэш (Gemma 4 26B A4B)" },
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
