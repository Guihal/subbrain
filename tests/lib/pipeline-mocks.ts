/**
 * Shared mock router + fixtures for AgentPipeline tests.
 * Not a test file — does not match `*.test.ts`.
 */

import { unlinkSync } from "node:fs";
import { AgentPipeline } from "@subbrain/agent/pipeline";
import { RAGPipeline } from "@subbrain/agent/rag";
import { MemoryDB } from "@subbrain/core/db";
import type { ChatResponse, Message } from "@subbrain/core/types/providers";

export type ChatCall = { model: string; messages: Message[] };

const baseResp: ChatResponse = {
  id: "test-id",
  object: "chat.completion",
  created: Date.now(),
  model: "mock",
  choices: [
    { index: 0, message: { role: "assistant", content: "Mock response" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const flashSummary: ChatResponse = {
  ...baseResp,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Executive summary: the project uses Bun + Elysia." },
      finish_reason: "stop",
    },
  ],
};

const flashDelta: ChatResponse = {
  ...baseResp,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: '{"facts": [], "skip": true}' },
      finish_reason: "stop",
    },
  ],
};

export function createMockRouter(chatCalls: ChatCall[]) {
  return {
    chat: async (model: string, params: any) => {
      chatCalls.push({ model, messages: params.messages });
      if (model === "flash") {
        const sys = params.messages?.[0]?.content || "";
        if (sys.includes("knowledge extractor")) return flashDelta;
        return flashSummary;
      }
      return baseResp;
    },
    chatStream: async () =>
      new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\n'),
          );
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
    scheduleRaw: async (_p: string, fn: () => Promise<any>) => fn(),
    raw: {
      embed: async () => ({ data: [{ embedding: new Array(2048).fill(0) }] }),
      rerank: async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }),
    },
  } as any;
}

export function setupPipeline(dbPath: string) {
  try {
    unlinkSync(dbPath);
  } catch {}
  const memory = new MemoryDB(dbPath);
  const chatCalls: ChatCall[] = [];
  const router = createMockRouter(chatCalls);
  const rag = new RAGPipeline(memory, router);
  const pipeline = new AgentPipeline(memory, router, rag);
  memory.setFocus("identity", "I am the TeamLead AI");
  memory.setFocus("directive", "Help build the subbrain project");
  memory.insertContext(
    "ctx-test-1",
    "Stack Choice",
    "We chose Bun + Elysia for the server runtime because of performance",
    "bun,elysia,architecture",
  );
  return { memory, pipeline, chatCalls };
}

export function teardown(dbPath: string) {
  try {
    unlinkSync(dbPath);
  } catch {}
}
