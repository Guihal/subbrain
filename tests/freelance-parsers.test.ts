import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseFl, parseFreelance, parseKwork } from "../src/scheduler/freelance/parsers";

const FL = readFileSync("tests/fixtures/freelance/fl-snapshot.txt", "utf8");
const KWORK = readFileSync("tests/fixtures/freelance/kwork-snapshot.txt", "utf8");
const FREELANCE = readFileSync("tests/fixtures/freelance/freelance-snapshot.txt", "utf8");

describe("freelance parsers", () => {
  test("fl.ru: extracts project links + budgets", () => {
    const items = parseFl(FL);
    expect(items.length).toBe(3);
    const bot = items.find((i) => i.title.includes("бота"));
    expect(bot?.source).toBe("fl.ru");
    expect(bot?.budget).toBe(5000);
    expect(bot?.deadlineDays).toBe(3);
    const landing = items.find((i) => i.title.includes("Верстка"));
    expect(landing?.budget).toBe(15000);
    expect(landing?.deadlineDays).toBe(5);
  });

  test("fl.ru: dedups repeated links", () => {
    const dup = `${FL}\n[5] link "бот" → https://www.fl.ru/projects/12345/napisat-bota.html\n`;
    const items = parseFl(dup);
    const urls = items.map((i) => i.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("kwork.ru: parses", () => {
    const items = parseKwork(KWORK);
    expect(items.length).toBe(2);
    expect(items[0]?.source).toBe("kwork.ru");
    expect(items.find((i) => i.title.includes("Python"))?.budget).toBe(3500);
    expect(items.find((i) => i.title.includes("Миграция"))?.budget).toBe(20000);
  });

  test("freelance.ru: parses", () => {
    const items = parseFreelance(FREELANCE);
    expect(items.length).toBe(2);
    expect(items.find((i) => i.title.includes("Скрипт"))?.budget).toBe(4000);
    expect(items.find((i) => i.title.includes("Slack"))?.budget).toBe(12000);
  });

  test("empty snapshot → empty list", () => {
    expect(parseFl("")).toEqual([]);
    expect(parseKwork("")).toEqual([]);
    expect(parseFreelance("")).toEqual([]);
  });

  // Regression: real-prod snapshots saved by scripts/freelance-probe.ts.
  // Asserts the parsers still extract items from the live page shape.
  // Refresh fixtures with `bun run scripts/freelance-probe.ts --save`.
  describe("real fixtures", () => {
    const cases: Array<{
      name: string;
      file: string;
      parse: (s: string) => ReturnType<typeof parseFl>;
      urlRe: RegExp;
    }> = [
      {
        name: "fl.ru",
        file: "tests/fixtures/freelance/fl.ru-real.txt",
        parse: parseFl,
        urlRe: /^https:\/\/www\.fl\.ru\/projects\/\d+/,
      },
      {
        name: "kwork.ru",
        file: "tests/fixtures/freelance/kwork.ru-real.txt",
        parse: parseKwork,
        urlRe: /^https:\/\/kwork\.ru\/projects\/\d+/,
      },
      {
        name: "freelance.ru",
        file: "tests/fixtures/freelance/freelance.ru-real.txt",
        parse: parseFreelance,
        urlRe: /^https:\/\/freelance\.ru\/projects\/.+\.html$/,
      },
    ];
    for (const c of cases) {
      test(`${c.name}: real snapshot yields parseable items`, () => {
        const snap = (() => {
          try {
            return readFileSync(c.file, "utf8");
          } catch {
            return "";
          }
        })();
        if (!snap) return; // fixture not captured yet — skip silently
        const items = c.parse(snap);
        expect(items.length).toBeGreaterThan(5);
        for (const item of items) {
          expect(item.url).toMatch(c.urlRe);
          expect(item.title.length).toBeGreaterThan(0);
        }
      });
    }
  });
});
