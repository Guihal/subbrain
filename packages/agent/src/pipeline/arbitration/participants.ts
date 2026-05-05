import type { TaskCategory } from "./weights";

export interface ParticipantInput {
  userMessage: string;
  executiveSummary: string;
  category: TaskCategory;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ParticipantOutput {
  id: string;
  content: string;
  latencyMs: number;
  timedOut: boolean;
  confidence?: number;
  artifacts?: unknown[];
}

export interface RoomParticipant {
  id: string;
  kind: "local" | "remote";
  capabilities: string[];
  ask(input: ParticipantInput): Promise<ParticipantOutput>;
}
