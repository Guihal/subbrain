/**
 * AgentService — PR 26b (LAYER-4) + PR 27 (Repository swap).
 *
 * Thin wrapper over `AgentLoop` so entry points (`routes/autonomous.ts`,
 * `app/schedulers.ts:installAutonomousScheduler`, `scheduler/free-agent.ts`)
 * stop touching the loop directly.
 *
 * SCHED-1 (PR 21) semantics live here now: callers declare `agentMode` and
 * the service forwards it to `AgentLoop.run` / `.createStream`. Scheduler
 * callers pass `"scheduled"` (hides `create_tool` / `create_code_tool` /
 * `edit_code_tool`); the interactive `/v1/autonomous` route passes
 * `"interactive"` (full agent-only tool set).
 *
 * The env override `SCHEDULED_ALLOW_CODE_TOOL_CREATE` is read by the
 * registry (`registry.toOpenAIToolsForAgent`), not here — this service only
 * threads the `agentMode` through, so the opt-in keeps working as before.
 *
 * PR 27 change: ctor's 2nd arg is now `ChatRepository` (reserved for the
 * planned "persist agent run handle for scheduled tasks" feature) rather
 * than the `MemoryDB` god-object. Unused at the moment — the contract is
 * intentional so callers don't start reaching for memory through the
 * AgentService back-door.
 */
import type { AgentLoop } from "../pipeline/agent-loop";
import type { AgentLoopResult, AgentMode } from "../pipeline/agent-loop";
import type { ScheduleContext } from "../pipeline/agent-loop/types";
import type { Priority } from "../lib/model-map";
import type { ChatRepository } from "../repositories";

export interface AgentRunOpts {
  task: string;
  agentMode: AgentMode;
  model?: string;
  priority?: Priority;
  maxSteps?: number;
  sessionId?: string;
  schedule?: ScheduleContext;
  /** B-1: per-agent identity for context-layer scoping; null = unscoped. */
  agentId?: string | null;
}

export class AgentService {
  constructor(
    private readonly agentLoop: AgentLoop,
    // Reserved for future: direct chat ops (e.g. persisting a handle for
    // scheduled runs). Keep tied to ChatRepository so we don't re-open the
    // door to the MemoryDB god-object.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly _chat: ChatRepository,
  ) {}

  async run(opts: AgentRunOpts): Promise<AgentLoopResult> {
    return this.agentLoop.run(this.toRequest(opts));
  }

  createStream(opts: AgentRunOpts): ReadableStream<Uint8Array> {
    return this.agentLoop.createStream(this.toRequest(opts));
  }

  private toRequest(opts: AgentRunOpts) {
    return {
      task: opts.task,
      model: opts.model ?? "teamlead",
      priority: opts.priority ?? "low",
      maxSteps: opts.maxSteps,
      sessionId: opts.sessionId,
      agentMode: opts.agentMode,
      agentId: opts.agentId ?? null,
      schedule: opts.schedule,
    };
  }
}
