/**
 * Persona identities for each virtual model role.
 * Injected into every request's system prompt so the model
 * always knows who it is and what the mission is.
 */

export type { Persona } from "./types";
export { PERSONAS } from "./profiles";
import { PERSONAS } from "./profiles";
import { systemPreamble } from "./preamble";

/** Get persona bio for a virtual model name. Falls back to a generic bio. */
export function getPersonaBio(model: string): string {
  const body =
    PERSONAS[model]?.body ??
    "Твоя роль: ассистент. Помоги пользователю с его задачей.";
  return `${systemPreamble()}\n\n${body}`;
}
