/**
 * done_with_artifact — agent-only termination signal with structured outcome.
 *
 * Mirrors inline `done` semantics but adds status/artifact/reason.
 * Tool-runner special-cases this name (like `done`) to return raw data
 * so tool-dispatch.ts can detect the control signal.
 */

import type { ToolResult } from "../../types";

export type TerminationStatus = "complete" | "noop" | "failed";

export interface DoneWithArtifactArgs {
  status: TerminationStatus;
  artifact?: string;
  reason?: string;
}

let terminated = false;

export function resetTermination(): void {
  terminated = false;
}

export function isTerminated(): boolean {
  return terminated;
}

export function doneWithArtifact(args: DoneWithArtifactArgs): ToolResult {
  if (terminated) {
    return { success: false, error: { code: "already_terminated", message: "Session already terminated" } };
  }

  if (args.status === "complete" && (!args.artifact || args.artifact.trim().length === 0)) {
    return { success: false, error: { code: "missing_artifact", message: "status=complete requires artifact" } };
  }

  if (args.status === "failed" && (!args.reason || args.reason.trim().length === 0)) {
    return { success: false, error: { code: "missing_reason", message: "status=failed requires reason" } };
  }

  terminated = true;

  const payload: Record<string, unknown> = { status: args.status };
  if (args.artifact !== undefined) payload.artifact = args.artifact;
  if (args.reason !== undefined) payload.reason = args.reason;

  return { success: true, data: payload };
}
