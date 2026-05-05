/**
 * @subbrain/plugin-freelance-scout
 *
 * No-op plugin shell that re-exports the existing scheduler entry points.
 * The actual FreelanceScout class and lifecycle live in
 * packages/agent/src/scheduler/freelance/* unchanged.
 *
 * Future packets can move logic here without touching call sites again.
 */
import type { Plugin } from "@subbrain/plugin";

export {
  FreelanceScout,
  type FreelanceScoutConfig,
  type FreelanceScoutDeps,
} from "../../src/scheduler/freelance";

export const freelanceScoutPlugin: Plugin = {
  name: "@subbrain/plugin-freelance-scout",
  setup() {
    // Shell: no hooks in A2. Scheduler lifecycle managed by
    // installFreelanceScoutScheduler in packages/server/src/app/schedulers.ts.
  },
};
