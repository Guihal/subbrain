/**
 * Types and interfaces for the agent pipeline.
 */
import type { Message, ChatResponse } from "../../providers/types";
import type { RAGResult } from "../../rag";
import type { SharedRow } from "../../db";

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
}

export interface PipelineResult {
  requestId: string;
  sessionId: string;
  response?: ChatResponse;
  stream?: ReadableStream<Uint8Array>;
}

export interface PreProcessingOutput {
  executiveSummary: string;
  ragResults: RAGResult[];
  focusEntries: Record<string, string>;
  sharedMemory: SharedRow[];
  rawMemoryBlock: string;
}
