/**
 * Types and interfaces for the agent pipeline.
 */

import type { SharedRow } from "@subbrain/core/db";
import type { ChatResponse, Message } from "@subbrain/providers/types";
import type { RAGResult } from "../../rag";

export interface PipelineRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  sessionId?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: any[];
  tool_choice?: any;
  /**
   * B-1: per-agent identity used to scope context-layer reads/writes (RAG +
   * hippocampus). Absent / null = no scope (chat-route default — admin /
   * legacy back-compat). Schedulers and explicit per-agent flows pass a
   * string.
   */
  agentId?: string | null;
}

export interface PipelineResult {
  requestId: string;
  sessionId: string;
  response?: ChatResponse;
  stream?: ReadableStream<Uint8Array>;
}

/** Minimum combined (user + assistant) length to trigger post-processing extraction. */
export const MIN_EXTRACTION_LENGTH = 100;

export interface PreProcessingOutput {
  executiveSummary: string;
  ragResults: RAGResult[];
  focusEntries: Record<string, string>;
  sharedMemory: SharedRow[];
  rawMemoryBlock: string;
}
