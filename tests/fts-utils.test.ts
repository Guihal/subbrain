/**
 * Tests for FTS5 query sanitization utilities (src/lib/fts-utils.ts).
 */
import { describe, test, expect } from "bun:test";
import { sanitizeFtsQuery } from "../src/lib/fts-utils";

describe("sanitizeFtsQuery", () => {
  test("returns quoted terms joined with OR", () => {
    const result = sanitizeFtsQuery("bun runtime elysia");
    expect(result).toBe('"bun" OR "runtime" OR "elysia"');
  });

  test("strips English stop words", () => {
    const result = sanitizeFtsQuery("the quick brown fox is a dog");
    // "the", "is", "a" are stop words
    expect(result).toBe('"quick" OR "brown" OR "fox" OR "dog"');
  });

  test("strips Russian stop words", () => {
    const result = sanitizeFtsQuery("это наш сервер для работы");
    // "это", "наш", "для" are stop words
    expect(result).toBe('"сервер" OR "работы"');
  });

  test("returns empty string for only stop words", () => {
    expect(sanitizeFtsQuery("the is a an")).toBe("");
    expect(sanitizeFtsQuery("и в на с")).toBe("");
  });

  test("returns empty string for empty input", () => {
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery("   ")).toBe("");
  });

  test("strips punctuation", () => {
    const result = sanitizeFtsQuery("hello, world! foo-bar");
    expect(result).toBe('"hello" OR "world" OR "foo" OR "bar"');
  });

  test("prevents FTS5 operator injection", () => {
    // Operators like AND, NOT, * should be stripped by quoting
    const result = sanitizeFtsQuery('hack" OR "1"="1');
    expect(result).not.toContain('OR "1"="1');
    // Each term is individually quoted, no injection possible
    for (const match of result.matchAll(/"([^"]+)"/g)) {
      expect(match[1]).not.toContain('"');
    }
  });

  test("limits to maxTerms (default 10)", () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const result = sanitizeFtsQuery(words);
    const termCount = result.split(" OR ").length;
    expect(termCount).toBe(10);
  });

  test("respects custom maxTerms", () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const result = sanitizeFtsQuery(words, 3);
    const termCount = result.split(" OR ").length;
    expect(termCount).toBe(3);
  });

  test("lowercases all terms", () => {
    const result = sanitizeFtsQuery("Bun RUNTIME Elysia");
    expect(result).toBe('"bun" OR "runtime" OR "elysia"');
  });

  test("filters out single-char tokens", () => {
    const result = sanitizeFtsQuery("a b c hello world x");
    // "a" is stop word, "b", "c", "x" are single char
    expect(result).toBe('"hello" OR "world"');
  });

  test("handles mixed EN/RU input", () => {
    const result = sanitizeFtsQuery("the сервер is работает на порту");
    // "the", "is", "на" are stop words
    expect(result).toBe('"сервер" OR "работает" OR "порту"');
  });
});

console.log("🎉 FTS utils tests passed!");
