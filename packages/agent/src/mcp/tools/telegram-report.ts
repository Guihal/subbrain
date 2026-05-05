/**
 * sendReport — обёртка `tgSendMessage` с RAG-обогащением.
 *
 * Перед отправкой отчёта в Telegram клеит сверху контекст, собранный
 * buildReportContext. Kill-switch: REPORT_RAG=false → шлём сырой текст.
 */
import type { MemoryDB } from "@subbrain/core/db";
import type { RAGPipeline } from "../../rag";
import { buildReportContext, truncateReportContext } from "../../rag";
import type { PublicToolContext } from "../registry/tool-registry";
import type { ToolResult } from "../types";

/** Максимум байт под весь результат (TG ≈ 4096 chars, ~3500 байт с запасом). */
const REPORT_MAX_BYTES = 3500;
/** Лимит на сам context (без основного текста). */
const CONTEXT_MAX_BYTES = 3000;

export interface SendReportOptions {
  topic?: string;
  sinceHours?: number;
  memory?: MemoryDB;
  rag?: RAGPipeline | null;
  /** Override для тестов: альтернативный сборщик контекста. */
  buildContext?: (args: { topic?: string; sinceHours?: number }) => Promise<string>;
}

function reportRagEnabled(): boolean {
  const v = process.env.REPORT_RAG;
  if (v === undefined) return true;
  return v.toLowerCase() !== "false" && v !== "0";
}

function extractTopic(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine
    .replace(/^[#\s*_>-]+/, "")
    .slice(0, 120)
    .trim();
}

export async function sendReport(
  ctx: PublicToolContext,
  text: string,
  opts: SendReportOptions = {},
): Promise<ToolResult> {
  if (!reportRagEnabled()) {
    return ctx.executor.tgSendMessage(text);
  }

  const topic = opts.topic ?? extractTopic(text);
  const sinceHours = opts.sinceHours ?? 24;

  let context = "";
  try {
    if (opts.buildContext) {
      context = await opts.buildContext({ topic, sinceHours });
    } else if (opts.memory) {
      context = await buildReportContext({
        memory: opts.memory,
        rag: opts.rag ?? null,
        topic,
        sinceHours,
      });
    }
  } catch {
    context = "";
  }

  if (!context.trim()) return ctx.executor.tgSendMessage(text);

  const trimmedContext = truncateReportContext(context, CONTEXT_MAX_BYTES);
  const joined = trimmedContext ? `${trimmedContext}\n\n---\n\n${text}` : text;
  const final = truncateReportContext(joined, REPORT_MAX_BYTES) || text;

  return ctx.executor.tgSendMessage(final);
}
