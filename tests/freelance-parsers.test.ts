import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { parseFl, parseKwork, parseFreelance } from "../src/scheduler/freelance/parsers";

const FL = readFileSync("tests/fixtures/freelance/fl-snapshot.txt", "utf8");
const KWORK = readFileSync("tests/fixtures/freelance/kwork-snapshot.txt", "utf8");
const FREELANCE = readFileSync(
  "tests/fixtures/freelance/freelance-snapshot.txt",
  "utf8",
);

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
    const dup = FL + "\n[5] link \"бот\" → https://www.fl.ru/projects/12345/napisat-bota.html\n";
    const items = parseFl(dup);
    const urls = items.map((i) => i.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("kwork.ru: parses", () => {
    const items = parseKwork(KWORK);
    expect(items.length).toBe(2);
    expect(items[0]!.source).toBe("kwork.ru");
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
});
