/**
 * Utility functions for the agent pipeline.
 */
import type { Message } from "../../providers/types";
import type { PreProcessingOutput } from "./types";
import { getPersonaBio } from "../../lib/personas";

export function extractLastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].content) {
      return messages[i].content!;
    }
  }
  return "";
}

export function isFirstMessage(messages: Message[]): boolean {
  return !messages.some((m) => m.role === "assistant");
}

export function buildSystemPrompt(pre: PreProcessingOutput, model: string): string {
  const parts: string[] = [];

  parts.push(getPersonaBio(model));

  if (Object.keys(pre.focusEntries).length > 0) {
    parts.push("\n## Текущие директивы (Layer 1: Focus)");
    for (const [key, value] of Object.entries(pre.focusEntries)) {
      parts.push(`- **${key}:** ${value}`);
    }
  }

  if (pre.sharedMemory && pre.sharedMemory.length > 0) {
    parts.push("\n## Общая память (факты о пользователе)");
    for (const entry of pre.sharedMemory) {
      parts.push(`- [${entry.category}] ${entry.content}`);
    }
  }

  if (pre.executiveSummary) {
    parts.push("\n## Executive Summary (собрано гиппокампом)");
    parts.push(pre.executiveSummary);
  }

  if (pre.rawMemoryBlock) {
    parts.push("\n## Raw Memory Dump (полный контекст из памяти)");
    parts.push(pre.rawMemoryBlock);
  }

  return parts.join("\n");
}

export function injectSystemPrompt(messages: Message[], systemAddition?: string): Message[] {
  if (!systemAddition) return messages;

  const result = [...messages];
  const sysIdx = result.findIndex((m) => m.role === "system");

  if (sysIdx >= 0) {
    result[sysIdx] = {
      ...result[sysIdx],
      content: systemAddition + "\n\n" + (result[sysIdx].content || ""),
    };
  } else {
    result.unshift({ role: "system", content: systemAddition });
  }

  return result;
}
