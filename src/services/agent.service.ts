/**
 * AgentService — PR 26b (LAYER-4). Thin wrapper over `AgentLoop` so entry
 * points (`routes/autonomous.ts`, `app/schedulers.ts:installAutonomousScheduler`,
 * `scheduler/free-agent.ts`) stop touching the loop directly.
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
 */
import type { AgentLoop } from "../pipeline/agent-loop";
import type { AgentLoopResult, AgentMode } from "../pipeline/agent-loop";
import type { ScheduleContext } from "../pipeline/agent-loop/types";
import type { Priority } from "../lib/model-map";
import type { MemoryDB } from "../db";

export interface AgentRunOpts {
  task: string;
  agentMode: AgentMode;
  model?: string;
  priority?: Priority;
  maxSteps?: number;
  sessionId?: string;
  schedule?: ScheduleContext;
}

export class AgentService {
  constructor(
    private readonly agentLoop: AgentLoop,
    // Reserved for future: direct memory ops (e.g. persisting a handle for
    // scheduled runs). ChatService also takes memory; keep the shape aligned.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly _memory: MemoryDB,
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
      schedule: opts.schedule,
    };
  }
}
