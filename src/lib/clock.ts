/**
 * Единый источник времени для системных промптов: Europe/Moscow (UTC+3).
 * Формат: "2026-04-21 14:30 MSK (UTC+3)".
 */

const TZ = "Europe/Moscow";

export function getMoscowNow(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} MSK (UTC+3)`;
}

export function getMoscowDate(now: Date = new Date()): string {
  return getMoscowNow(now).slice(0, 10);
}
