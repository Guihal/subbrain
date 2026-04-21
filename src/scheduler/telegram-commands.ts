/**
 * Pure command parsing + task-list mutation for the Telegram poller.
 * Isolated from IO so unit tests can exercise parse/apply without MTProto/bot.
 */

export type TaskKind = "work" | "home";

export interface Task {
  id: string;
  text: string;
  created_at: number;
  due?: number;
}

export type Command =
  | { kind: "add"; list: TaskKind; text: string; due?: number }
  | { kind: "done"; id: string }
  | { kind: "list"; list: TaskKind }
  | { kind: "unknown" };

const DUE_RE = /\s*!(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?\s*$/;

function parseDue(raw: string): { text: string; due?: number } {
  const m = raw.match(DUE_RE);
  if (!m) return { text: raw.trim() };
  const [, date, hh = "00", mm = "00"] = m;
  const iso = `${date}T${hh.padStart(2, "0")}:${mm}:00Z`;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return { text: raw.trim() };
  return {
    text: raw.slice(0, m.index).trim(),
    due: Math.floor(ts / 1000),
  };
}

export function parseCommand(raw: string): Command {
  const text = raw.trim();
  if (!text) return { kind: "unknown" };

  const addMatch = text.match(/^\+task\s+(work|home)\s+(.+)$/i);
  if (addMatch) {
    const list = addMatch[1].toLowerCase() as TaskKind;
    const { text: body, due } = parseDue(addMatch[2]);
    if (!body) return { kind: "unknown" };
    return due !== undefined
      ? { kind: "add", list, text: body, due }
      : { kind: "add", list, text: body };
  }

  const doneMatch = text.match(/^done\s+([wh]\d+)$/i);
  if (doneMatch) return { kind: "done", id: doneMatch[1].toLowerCase() };

  const listMatch = text.match(/^list\s+(work|home)$/i);
  if (listMatch) {
    return { kind: "list", list: listMatch[1].toLowerCase() as TaskKind };
  }

  return { kind: "unknown" };
}

export interface TaskState {
  "tasks.work": Task[];
  "tasks.home": Task[];
}

export function emptyState(): TaskState {
  return { "tasks.work": [], "tasks.home": [] };
}

function prefix(list: TaskKind): "w" | "h" {
  return list === "work" ? "w" : "h";
}

function nextId(list: TaskKind, tasks: Task[]): string {
  const p = prefix(list);
  let max = 0;
  for (const t of tasks) {
    const m = t.id.match(/^[wh](\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${p}${max + 1}`;
}

export interface ApplyResult {
  state: TaskState;
  receipt: string;
}

export function applyCommand(
  state: TaskState,
  cmd: Command,
  now: number,
): ApplyResult {
  if (cmd.kind === "unknown") {
    return { state, receipt: "? команда не распознана" };
  }
  if (cmd.kind === "add") {
    const key = cmd.list === "work" ? "tasks.work" : "tasks.home";
    const arr = state[key].slice();
    const id = nextId(cmd.list, arr);
    const task: Task = { id, text: cmd.text, created_at: now };
    if (cmd.due !== undefined) task.due = cmd.due;
    arr.push(task);
    const next = { ...state, [key]: arr } as TaskState;
    return { state: next, receipt: `✓ ${cmd.list}: ${id} добавлена` };
  }
  if (cmd.kind === "done") {
    const key: keyof TaskState = cmd.id.startsWith("w")
      ? "tasks.work"
      : "tasks.home";
    const before = state[key];
    const after = before.filter((t) => t.id !== cmd.id);
    if (after.length === before.length) {
      return { state, receipt: `? задача ${cmd.id} не найдена` };
    }
    const next = { ...state, [key]: after } as TaskState;
    return { state: next, receipt: `✓ ${cmd.id} закрыта` };
  }
  // list
  const arr = state[cmd.list === "work" ? "tasks.work" : "tasks.home"];
  if (!arr.length) {
    return { state, receipt: `${cmd.list}: пусто` };
  }
  const lines = arr.map(
    (t) => `${t.id}: ${t.text}${t.due ? ` (до ${new Date(t.due * 1000).toISOString().slice(0, 16).replace("T", " ")})` : ""}`,
  );
  return { state, receipt: `${cmd.list}:\n${lines.join("\n")}` };
}

export interface RemindCandidate {
  list: TaskKind;
  task: Task;
  reason: "overdue" | "stale";
}

export function collectRemindCandidates(
  state: TaskState,
  now: number,
  staleSeconds: number,
): RemindCandidate[] {
  const out: RemindCandidate[] = [];
  const pairs: { key: keyof TaskState; list: TaskKind }[] = [
    { key: "tasks.work", list: "work" },
    { key: "tasks.home", list: "home" },
  ];
  for (const { key, list } of pairs) {
    for (const t of state[key]) {
      if (t.due !== undefined && t.due < now) {
        out.push({ list, task: t, reason: "overdue" });
        continue;
      }
      if (t.due === undefined && t.created_at < now - staleSeconds) {
        out.push({ list, task: t, reason: "stale" });
      }
    }
  }
  out.sort((a, b) => a.task.created_at - b.task.created_at);
  return out;
}

export function buildRemindPrompt(
  candidates: RemindCandidate[],
  state: TaskState,
): string {
  const workN = state["tasks.work"].length;
  const homeN = state["tasks.home"].length;
  const overdueN = candidates.filter((c) => c.reason === "overdue").length;
  const top = candidates.slice(0, 6).map(
    (c) => `- [${c.list}/${c.reason}] ${c.task.id}: ${c.task.text}`,
  );
  return [
    `Ты — ассистент. Сформируй 1-2 строки напоминания про задачи.`,
    `Счётчики: work=${workN}, home=${homeN}, overdue=${overdueN}.`,
    `Топ кандидатов:`,
    top.join("\n"),
    `Формат: «🔔 Work: N задач (K просрочены). Срочно: …. Home: M».`,
  ].join("\n");
}
