/**
 * Shared typed fixtures for `agent-loop` tests. Not a `*.test.ts` — `bun test`
 * ignores this. Per-test `overrides` give the minimal surface needed; defaults
 * stay no-op so unrelated fields don't drift when the underlying types grow.
 */

import type { ToolExecutor } from "@subbrain/agent/mcp";
import { ToolRegistry } from "@subbrain/agent/mcp";
import type { CodeToolRegistry } from "@subbrain/agent/pipeline/agent-loop/code-tools";
import { DynamicToolRegistry } from "@subbrain/agent/pipeline/agent-loop/dynamic-tools";
import type { AgentLoopDeps } from "@subbrain/agent/pipeline/agent-loop/shared";
import type { StepDeps } from "@subbrain/agent/pipeline/agent-loop/step";
import type { ToolRunnerDeps } from "@subbrain/agent/pipeline/agent-loop/tool-runner";
import type { AgentLoopSession } from "@subbrain/agent/pipeline/agent-loop/types";
import type { RAGPipeline } from "@subbrain/agent/rag";
import { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ChatResponse } from "@subbrain/core/types/providers";

export type RouterChatFn = ModelRouter["chat"];

export interface MakeRouterOpts {
  /** Override the full chat fn (signal capture, custom logic). */
  chat?: RouterChatFn;
  /** Override only the `ChatResponse` returned by the default chat fn. */
  response?: Partial<ChatResponse>;
}

export function makeStubRouter(opts: MakeRouterOpts = {}): ModelRouter {
  const full: ChatResponse = {
    id: "r1",
    object: "chat.completion",
    created: 0,
    model: "teamlead",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    ...opts.response,
  };
  const chat: RouterChatFn = opts.chat ?? (async () => full);
  return { chat } as unknown as ModelRouter;
}

export function makeStubMemory(): MemoryDB {
  return new MemoryDB(":memory:");
}

export function makeStubSession(): AgentLoopSession {
  return {
    consultSpecialistsCount: 0,
    consultSpecialistsMax: 3,
    consultChaosCount: 0,
    consultChaosMax: 5,
  };
}

export function makeToolRunnerDeps(overrides: Partial<ToolRunnerDeps> = {}): ToolRunnerDeps {
  return {
    registry: new ToolRegistry(),
    tools: {} as ToolExecutor,
    router: makeStubRouter(),
    room: null,
    dynamicTools: new DynamicToolRegistry(),
    persistDynamicTools: () => {},
    codeTools: null,
    session: makeStubSession(),
    agentId: null,
    agentMode: "interactive",
    ...overrides,
  };
}

export function makeStepDeps(overrides: Partial<StepDeps> = {}): StepDeps {
  return {
    router: overrides.router ?? makeStubRouter(),
    memory: overrides.memory ?? makeStubMemory(),
    tools: overrides.tools ?? makeToolRunnerDeps(),
  };
}

export function makeAgentLoopDeps(overrides: Partial<AgentLoopDeps> = {}): AgentLoopDeps {
  // RAG / code-tools have heavy real constructors; stub at one boundary so
  // tests that don't touch them stay cast-free downstream.
  const rag = overrides.rag ?? ({ search: async () => [] } as unknown as RAGPipeline);
  const codeTools = overrides.codeTools ?? ({} as CodeToolRegistry);
  return {
    memory: overrides.memory ?? makeStubMemory(),
    router: overrides.router ?? makeStubRouter(),
    rag,
    tools: overrides.tools ?? ({} as ToolExecutor),
    registry: overrides.registry ?? new ToolRegistry(),
    dynamicTools: overrides.dynamicTools ?? new DynamicToolRegistry(),
    codeTools,
    room: overrides.room ?? null,
    hooks: overrides.hooks,
    persistDynamicTools: overrides.persistDynamicTools ?? (() => {}),
    getAllTools: overrides.getAllTools ?? (() => []),
  };
}

/**
 * Build a `ToolRunnerDeps` whose `registry` resolves the given handler map.
 * Each handler receives the parsed `args` and returns the `data` placed in
 * `{success:true, data}`. `done` is special-cased upstream by the runner.
 */
export function makeToolRunnerDepsFromMap(
  registry: Record<string, (args: unknown) => unknown>,
): ToolRunnerDeps {
  const stub = {
    has: (name: string) => name in registry,
    call: async (name: string, args: unknown) => ({
      success: true,
      data: registry[name]?.(args),
    }),
    callAsAgent: async (name: string, args: unknown) => ({
      success: true,
      data: registry[name]?.(args),
    }),
  } as unknown as ToolRegistry;
  return makeToolRunnerDeps({ registry: stub });
}
