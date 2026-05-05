/**
 * Persona identities for each virtual model role.
 * Injected into every request's system prompt so the model
 * always knows who it is and what the mission is.
 */

export { PERSONAS } from "./profiles";
export type { Persona } from "./types";

import { systemPreamble } from "./preamble";
import { PERSONAS } from "./profiles";

/** Get persona bio for a virtual model name. Falls back to a generic bio. */
export function getPersonaBio(model: string): string {
  const body = PERSONAS[model]?.body ?? "Твоя роль: ассистент. Помоги пользователю с его задачей.";
  return `${systemPreamble()}\n\n${body}`;
}
