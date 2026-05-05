/**
 * Heuristic classifier: decides whether a user message needs the
 * multi-specialist arbitration room and which agents/category to use.
 * Returns null when single-model is enough.
 */

import type { RoomConfig } from "./types";

export function classifyMessage(userMessage: string): RoomConfig | null {
  const msg = userMessage.toLowerCase();

  // Explicit triggers
  if (
    msg.includes("обсудите") ||
    msg.includes("покажите разные подходы") ||
    msg.includes("что думает команда") ||
    msg.includes("discuss") ||
    msg.includes("compare approaches")
  ) {
    return {
      agents: ["coder", "critic", "generalist", "chaos"],
      category: "architecture",
    };
  }

  // Architecture / design decisions
  if (
    msg.includes("как организовать") ||
    msg.includes("какой подход лучше") ||
    msg.includes("архитектура") ||
    msg.includes("architecture") ||
    msg.match(/\bили\b.*\bили\b/) || // "X или Y или Z"
    msg.match(/\bvs\b/) ||
    msg.includes("плюсы и минусы") ||
    msg.includes("pros and cons")
  ) {
    return {
      agents: ["coder", "critic", "generalist", "chaos"],
      category: "architecture",
    };
  }

  // Code review
  if (
    msg.includes("проверь") ||
    msg.includes("ревью") ||
    msg.includes("review") ||
    msg.includes("найди баги")
  ) {
    return { agents: ["coder", "critic"], category: "review" };
  }

  // Complex reasoning
  if (
    (msg.includes("почему") && msg.includes("не работает")) ||
    msg.includes("сложный баг") ||
    (msg.includes("debug") && msg.length > 200)
  ) {
    return { agents: ["coder", "generalist"], category: "reasoning" };
  }

  return null; // Single-model
}
