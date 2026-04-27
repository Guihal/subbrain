import type { MemoryRow } from "../useMemory";

export function fmtTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// M-12 (mig 15): archive confidence renders by threshold ≥ 0.8 → green
// ("HIGH"-equivalent), < 0.8 → gray, null → gray.
export function badgeColor(row: MemoryRow): string {
  switch (row.__kind) {
    case "focus":
      return "text-yellow-400";
    case "shared":
      return "text-blue-400";
    case "context":
      return "text-purple-400";
    case "archive":
      return row.confidence !== null && row.confidence >= 0.8
        ? "text-green-400"
        : "text-gray-400";
    case "agent":
      return "text-orange-400";
    case "log":
      return "text-sky-400";
  }
}

export function rowBadge(row: MemoryRow): string {
  switch (row.__kind) {
    case "focus":
      return "key";
    case "shared":
      return row.category || "?";
    case "context":
      return (row.agent_id || "auto").slice(0, 12);
    case "archive":
      return row.confidence === null ? "—" : row.confidence.toFixed(2);
    case "agent":
      return row.agent_id;
    case "log":
      return row.agent_id || row.role;
  }
}
