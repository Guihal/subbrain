import { describe, test, expect } from "bun:test";
import { getMoscowNow, getMoscowDate } from "../src/lib/clock";

describe("clock", () => {
  test("formats UTC 11:30 as MSK 14:30", () => {
    const d = new Date("2026-04-21T11:30:00Z");
    expect(getMoscowNow(d)).toBe("2026-04-21 14:30 MSK (UTC+3)");
  });

  test("handles day rollover across midnight UTC", () => {
    // 22:00 UTC → 01:00 MSK next day
    const d = new Date("2026-04-21T22:00:00Z");
    expect(getMoscowNow(d)).toBe("2026-04-22 01:00 MSK (UTC+3)");
  });

  test("current output matches expected shape", () => {
    expect(getMoscowNow()).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} MSK \(UTC\+3\)$/,
    );
  });

  test("getMoscowDate returns YYYY-MM-DD", () => {
    const d = new Date("2026-04-21T22:00:00Z");
    expect(getMoscowDate(d)).toBe("2026-04-22");
  });
});
