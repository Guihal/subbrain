/**
 * Prompt blocks for task-aware agents.
 *
 * Renders active tasks (per visible scope) and TG-poller status into the
 * system prompt — so the agent sees its current lifecycle state on every
 * rebuild and can't hallucinate closed tasks or stale TG reads.
 *
 * Unit contract:
 *  - `tasks.due_at` — unix seconds (unixepoch(), DB INTEGER).
 *  - `scheduler_state['tg.last_checked_at'].value` — stringified unix seconds.
 *    Phase 4 TG poller writes `String(Math.floor(Date.now()/1000))`.
 *
 * Pure: no logger, no side effects, no async. Safe to call on every build.
 */
import type { MemoryDB, TaskRow, TaskScope } from "@subbrain/core/db";

/**
 * Which task scopes an agent in `viewer` scope should see in its prompt.
 * `freelance` is namespace-isolated (scout works in its own domain; global
 * would be noise). All others see their own scope + global.
 */
export const SCOPE_VISIBILITY: Record<TaskScope, TaskScope[]> = {
  global: ["global"],
  autonomous: ["autonomous", "global"],
  "free-agent": ["free-agent", "global"],
  freelance: ["freelance"],
  tg: ["tg", "global"],
};

const STALE_TG_AGE_SEC = 300;
const TOP_N_PER_SCOPE = 5;
const TITLE_MAX = 120;

export function fmtShortDate(unixSec: number | null | undefined): string | null {
  if (unixSec == null || !Number.isFinite(unixSec) || unixSec <= 0) return null;
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

export function safeTitle(title: string): string {
  const collapsed = String(title)
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (collapsed.length <= TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX - 1)}…`;
}

function renderTaskLine(t: TaskRow): string {
  const icon = t.status === "in_progress" ? "⏳" : "📌";
  const idTag = `[${(t.id || "").slice(0, 6)}]`;
  const prio = t.priority > 0 ? ` p${t.priority}` : "";
  const due = fmtShortDate(t.due_at);
  const duePart = due ? ` due=${due}` : "";
  return `- ${icon} ${idTag}${prio}${duePart} ${safeTitle(t.title)}`;
}

function renderScopeSection(memory: MemoryDB, scope: TaskScope): { block: string; total: number } {
  const rows = memory.listTasksActive(scope, TOP_N_PER_SCOPE);
  const total = memory.countTasksActive(scope);
  if (total === 0) {
    return { block: `### ${scope}: _пусто_`, total };
  }
  const lines = rows.map(renderTaskLine);
  const overflow = total - rows.length;
  const tail =
    overflow > 0
      ? `\n_+${overflow} more in this scope; \`task_list({scope:"${scope}"})\` to see all._`
      : "";
  return {
    block: `### ${scope} (${total} active)\n${lines.join("\n")}${tail}`,
    total,
  };
}

/**
 * Render active tasks block. Returns empty string when all visible scopes are
 * empty — callers should filter(Boolean) before join.
 */
export function renderActiveTasks(memory: MemoryDB, viewer: TaskScope): string {
  const visible = SCOPE_VISIBILITY[viewer] ?? ["global"];
  const sections: string[] = [];
  let grandTotal = 0;
  for (const scope of visible) {
    const { block, total } = renderScopeSection(memory, scope);
    sections.push(block);
    grandTotal += total;
  }
  if (grandTotal === 0) return "";
  const header =
    "## Active tasks\n_Закрыл задачу — сразу `task_done({id})`. Новая — `task_add({scope,title,...})`._";
  return `${header}\n\n${sections.join("\n\n")}`;
}

/**
 * Render TG poller status block. Returns empty string when poller has never
 * checked AND there are no unread DMs — nothing worth surfacing.
 *
 * Scope filter is the caller's responsibility (only autonomous/tg/free-agent
 * need this block).
 */
export function renderTgStatus(memory: MemoryDB): string {
  const row = memory.getSchedulerState("tg.last_checked_at");
  const unread = memory.countTasksActive("tg");
  const ts = row ? Number(row.value) : Number.NaN;
  const hasValidTs = Number.isFinite(ts) && ts > 0;
  if (!hasValidTs && unread === 0) return "";
  if (!hasValidTs) {
    return buildTgBlock({
      stale: false,
      ageLabel: null,
      unread,
      noPoll: true,
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const age = Math.max(0, now - ts);
  const stale = age > STALE_TG_AGE_SEC;
  return buildTgBlock({
    stale,
    ageLabel: `${age}s ago`,
    unread,
    noPoll: false,
  });
}

function buildTgBlock(opts: {
  stale: boolean;
  ageLabel: string | null;
  unread: number;
  noPoll: boolean;
}): string {
  const head = opts.stale ? "## TG status ⚠️" : "## TG status";
  const lines: string[] = [head];
  if (opts.noPoll) {
    lines.push("_Poller не запускался в этой сессии._");
  } else {
    const staleTail = opts.stale ? " (STALE — poller dead?)" : "";
    lines.push(`- Last poll: ${opts.ageLabel}${staleTail}`);
  }
  lines.push(`- Unread DMs: ${opts.unread}`);
  if (opts.unread > 0) {
    lines.push(
      '_Если `tg_reply` вернул `tg_gone` — `task_cancel({id, reason:"tg: source deleted"})`._',
    );
  }
  return lines.join("\n");
}
