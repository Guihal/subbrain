/**
 * Shared classification helper for task-like memory rows.
 *
 * Used by both:
 *   - scripts/migrate-tasks-from-memory.ts (one-shot cleanup)
 *   - src/pipeline/night-cycle/prune/stray-tasks.ts (Step 12, continuous)
 *
 * The LLM decides whether a shared_memory / layer2_context row is actually
 * a task that should live in the tasks table, or a fact that should stay
 * where it is. `Classifier` is a minimal structural interface so tests can
 * inject a fake without pulling the full ModelRouter/Priority types.
 */

import type { TaskScope } from "../../../db";
import type { Priority } from "../../../lib/model-map";
import type { ChatParams, ChatResponse } from "../../../providers/types";
import { parseJson } from "../types";

export const TASK_TAG_KEYWORDS = [
  "task",
  "todo",
  "reminder",
  "deadline",
  "дедлайн",
  "задача",
] as const;

export const BLACKLIST_TAGS = ["architecture", "design", "pattern", "how-to"] as const;

// Tokens marking a completed/archived status. Checked per-token (not
// substring) because "done" is short enough to collide with normal words.
export const COMPLETED_STATUS_TAGS = [
  "done",
  "completed",
  "closed",
  "resolved",
  "выполнено",
  "закрыто",
] as const;

const VALID_SCOPES: readonly TaskScope[] = [
  "global",
  "autonomous",
  "free-agent",
  "freelance",
  "tg",
];

export interface Classifier {
  chat(
    virtualModel: string,
    params: Omit<ChatParams, "model">,
    priority?: Priority,
  ): Promise<ChatResponse>;
}

export interface CandidateRow {
  id: string;
  source_table: "shared_memory" | "layer2_context";
  content: string;
  tags: string;
  category?: string | null;
  title?: string | null;
  agent_id?: string | null;
}

export type ClassifyResult =
  | {
      action: "migrate";
      scope: TaskScope;
      title: string;
      description: string;
      priority: number;
      due_at: number | null;
    }
  | { action: "keep"; reason: string };

export function hasTaskTag(tags: string): boolean {
  if (!tags) return false;
  const lc = tags.toLowerCase();
  return TASK_TAG_KEYWORDS.some((k) => lc.includes(k));
}

export function hasBlacklistTag(tags: string): boolean {
  if (!tags) return false;
  const lc = tags.toLowerCase();
  return BLACKLIST_TAGS.some((k) => lc.includes(k));
}

export function hasCompletedStatusTag(tags: string): boolean {
  if (!tags) return false;
  const tokens = tags
    .toLowerCase()
    .split(",")
    .map((t) => t.trim());
  return tokens.some((t) => (COMPLETED_STATUS_TAGS as readonly string[]).includes(t));
}

export async function classifyCandidate(
  classifier: Classifier,
  row: CandidateRow,
  model: string = process.env.NIGHT_CYCLE_MODEL || "memory",
): Promise<ClassifyResult | null> {
  const userBody =
    `table=${row.source_table}\n` +
    `tags=${row.tags}\n` +
    (row.title ? `title=${row.title}\n` : "") +
    (row.category ? `category=${row.category}\n` : "") +
    `content=${row.content}`;

  const response = await classifier.chat(
    model,
    {
      messages: [
        { role: "system", content: CLASSIFY_PROMPT },
        { role: "user", content: userBody },
      ],
      max_tokens: 512,
      temperature: 0.1,
    },
    "low",
  );

  const parsed = parseJson(response.choices[0]?.message?.content || "");
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.action === "keep") {
    return {
      action: "keep",
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  }
  if (parsed.action !== "migrate") return null;
  if (!VALID_SCOPES.includes(parsed.scope)) return null;
  if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) {
    return null;
  }
  const priority =
    typeof parsed.priority === "number" && Number.isFinite(parsed.priority)
      ? Math.max(0, Math.min(10, Math.trunc(parsed.priority)))
      : 0;
  const due_at =
    typeof parsed.due_at === "number" && Number.isFinite(parsed.due_at) ? parsed.due_at : null;
  return {
    action: "migrate",
    scope: parsed.scope,
    title: parsed.title.trim(),
    description: typeof parsed.description === "string" ? parsed.description : "",
    priority,
    due_at,
  };
}

const CLASSIFY_PROMPT = `Ты классифицируешь запись памяти: это реально task/todo или это факт/знание?

Task признаки: глагол действия ("сделать", "написать", "поправить"), дедлайн, одноразовое намерение, прогресс.
Keep признаки: знание о юзере, архитектурное решение, паттерн, how-to, факт.

Ввод:
table=shared_memory|layer2_context
tags=<comma list>
title=<optional>
category=<optional>
content=<text>

Выводи строго один JSON без markdown:

Migrate (запись — task):
{"action":"migrate","scope":"global"|"autonomous"|"free-agent"|"freelance"|"tg","title":"≤80 chars","description":"детали (можно пустая строка)","priority":0..10,"due_at":null|unix-seconds}

Keep (запись — факт):
{"action":"keep","reason":"кратко почему это не task"}

Правила:
- Сомневаешься → "keep". False-positive (переместить факт как task) вреднее false-negative.
- scope=global если не очевиден владелец. scope=autonomous/free-agent/freelance/tg только если tags/context прямо указывают.
- title краткое, императив ("Написать X", "Проверить Y").
- priority 0 по умолчанию. Выше только при явном "срочно"/"важно".`;
