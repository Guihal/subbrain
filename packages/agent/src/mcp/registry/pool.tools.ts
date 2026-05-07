/**
 * Pool / agent-lifecycle tools (agent-only).
 */

import { doneWithArtifact, resetTermination } from "../tools/pool/done-with-artifact";
import { type ToolRegistry, t } from "./tool-registry";

export function registerPoolTools(registry: ToolRegistry): void {
  registry.register({
    name: "done_with_artifact",
    description:
      "Signal task completion with structured outcome. status=complete requires artifact; status=failed requires reason; status=noop needs neither. Returns control signal same as `done`.",
    scope: "agent-only",
    input: t.Object({
      status: t.Union([t.Literal("complete"), t.Literal("noop"), t.Literal("failed")], {
        description: "Termination status",
      }),
      artifact: t.Optional(
        t.String({ description: "Required when status=complete — deliverable / result" }),
      ),
      reason: t.Optional(t.String({ description: "Required when status=failed — explanation" })),
    }),
    handler: (args) => doneWithArtifact(args),
  });
}

export { resetTermination };
