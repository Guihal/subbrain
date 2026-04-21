/**
 * Report context assembler.
 *
 * Перед отправкой отчёта в Telegram собирает фактический контекст
 * из shared_memory (FTS), raw_log (за период) и context/archive (RAG hybrid).
 * Вывод — markdown с тремя секциями.
 */
import type { MemoryDB, LogRow, SharedRow } from "../db";
import type { RAGPipeline } from "./pipeline";

export interface BuildReportContextOptions {
  memory: MemoryDB;
  rag?: RAGPipeline | null;
  topic?: string;
  sinceHours?: number;
  /** Для тестов: override Date.now() (в мс). */
  nowMs?: number;
  /** top-N для shared/context. */
  factsLimit?: number;
  ragTopN?: number;
  logLimit?: number;
}

const DEFAULT_SINCE_HOURS = 24;
const DEFAULT_FACTS_LIMIT = 10;
const DEFAULT_RAG_TOP_N = 5;
const DEFAULT_LOG_LIMIT = 30;

/** Технические роли/маркеры в raw_log — отчёт их не показывает. */
const TECHNICAL_ROLES = new Set(["system", "tool"]);
const TECHNICAL_CONTENT_PATTERNS = [/^stream-chunk/i, /^\[heartbeat\]/i];

function isTechnicalLog(row: LogRow): boolean {
  if (TECHNICAL_ROLES.has(row.role)) return true;
  return TECHNICAL_CONTENT_PATTERNS.some((re) => re.test(row.content));
}

function trim(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() + "…" : clean;
}

function formatTs(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${mo}-${day} ${hh}:${mm}`;
}

async function collectFacts(
  memory: MemoryDB,
  topic: string,
  limit: number,
): Promise<SharedRow[]> {
  if (!topic.trim()) return memory.listShared(limit);
  const hits = memory.searchShared(topic, limit);
  if (hits.length === 0) return memory.listShared(limit);
  const rehydrated: SharedRow[] = [];
  for (const h of hits) {
    const row = memory.getShared(h.id);
    if (row) rehydrated.push(row);
  }
  return rehydrated;
}

interface RagHit {
  layer: string;
  title: string;
  snippet: string;
}

async function collectRag(
  rag: RAGPipeline | null | undefined,
  topic: string,
  topN: number,
): Promise<RagHit[]> {
  if (!rag || !topic.trim()) return [];
  try {
    const results = await rag.search({
      query: topic,
      layers: ["context", "archive"],
      rerankTopN: topN,
    });
    return results.map((r) => ({
      layer: r.layer,
      title: r.title,
      snippet: r.snippet,
    }));
  } catch {
    return [];
  }
}

function collectLogs(
  memory: MemoryDB,
  sinceHours: number,
  limit: number,
  nowMs: number,
): LogRow[] {
  const sinceUnix = Math.floor(nowMs / 1000) - sinceHours * 3600;
  const rows = memory.getLogsSinceTime(sinceUnix, limit * 4);
  const filtered = rows.filter((r) => !isTechnicalLog(r));
  return filtered.slice(0, limit);
}

function renderFacts(rows: SharedRow[]): string[] {
  return rows.map((r) => `- ${trim(r.content, 200)}`);
}

function renderLogs(rows: LogRow[]): string[] {
  return rows.map(
    (r) => `- [${formatTs(r.created_at)}] ${r.role}: ${trim(r.content, 220)}`,
  );
}

function renderRag(hits: RagHit[]): string[] {
  return hits.map(
    (h) => `- [${h.layer}] ${h.title}: ${trim(h.snippet, 200)}`,
  );
}

/**
 * Собирает markdown с фактами, последними событиями и RAG-контекстом.
 * Пустые секции опускаются. Порядок: Факты → Последние события → Связанный контекст.
 */
export async function buildReportContext(
  opts: BuildReportContextOptions,
): Promise<string> {
  const {
    memory,
    rag,
    topic = "",
    sinceHours = DEFAULT_SINCE_HOURS,
    nowMs = Date.now(),
    factsLimit = DEFAULT_FACTS_LIMIT,
    ragTopN = DEFAULT_RAG_TOP_N,
    logLimit = DEFAULT_LOG_LIMIT,
  } = opts;

  const [facts, logs, ragHits] = await Promise.all([
    collectFacts(memory, topic, factsLimit),
    Promise.resolve(collectLogs(memory, sinceHours, logLimit, nowMs)),
    collectRag(rag, topic, ragTopN),
  ]);

  const sections: string[] = [];

  const factsLines = renderFacts(facts);
  if (factsLines.length) sections.push(["## Факты", ...factsLines].join("\n"));

  const logsLines = renderLogs(logs);
  if (logsLines.length)
    sections.push(["## Последние события", ...logsLines].join("\n"));

  const ragLines = renderRag(ragHits);
  if (ragLines.length)
    sections.push(["## Связанный контекст", ...ragLines].join("\n"));

  return sections.join("\n\n");
}

const PRIORITY = ["## Последние события", "## Связанный контекст", "## Факты"];

/**
 * Обрезает контекст под лимит байт. Жертвуем секциями в порядке приоритета:
 * сначала «Последние события», потом «Связанный контекст», Факты режем последними.
 */
export function truncateReportContext(context: string, maxBytes: number): string {
  if (Buffer.byteLength(context, "utf8") <= maxBytes) return context;

  const parts = context.split(/\n\n(?=## )/);
  const byHeader = new Map<string, string>();
  for (const p of parts) {
    const head = p.slice(0, p.indexOf("\n"));
    byHeader.set(head, p);
  }

  for (const header of PRIORITY) {
    byHeader.delete(header);
    const candidate = Array.from(byHeader.values()).join("\n\n");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  }

  return "";
}
