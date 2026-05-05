import { describe, expect, test } from "bun:test";
import { scrubPII } from "@subbrain/core/lib/pii-scrub";

describe("scrubPII", () => {
  test("email", () => {
    const r = scrubPII("Contact a@b.com please");
    expect(r.scrubbed).toBe("Contact [REDACTED:email] please");
    expect(r.redacted_count).toBe(1);
    expect(r.types).toEqual(["email"]);
  });

  test("phone +7 format", () => {
    const r = scrubPII("call me at +7 901 555 0101");
    expect(r.scrubbed).toContain("[REDACTED:phone]");
    expect(r.redacted_count).toBe(1);
    expect(r.types).toEqual(["phone"]);
  });

  test("phone 8-xxx format", () => {
    const r = scrubPII("tel: 8-800-555-35-35");
    expect(r.scrubbed).toContain("[REDACTED:phone]");
    expect(r.redacted_count).toBe(1);
  });

  test("IBAN", () => {
    const r = scrubPII("IBAN: DE89370400440532013000");
    expect(r.scrubbed).toBe("IBAN: [REDACTED:iban]");
    expect(r.types).toEqual(["iban"]);
  });

  test("credit card", () => {
    const r = scrubPII("Card: 4111 1111 1111 1111");
    expect(r.scrubbed).toBe("Card: [REDACTED:card]");
    expect(r.types).toEqual(["card"]);
  });

  test("Russian passport", () => {
    const r = scrubPII("passport 4515 123456");
    expect(r.scrubbed).toBe("passport [REDACTED:passport_ru]");
    expect(r.types).toEqual(["passport_ru"]);
  });

  test("Russian INN 10 digits", () => {
    const r = scrubPII("INN 7707083893");
    expect(r.scrubbed).toBe("INN [REDACTED:inn_ru]");
    expect(r.types).toEqual(["inn_ru"]);
  });

  test("Russian INN 12 digits", () => {
    const r = scrubPII("INN 770708389301");
    expect(r.scrubbed).toBe("INN [REDACTED:inn_ru]");
    expect(r.types).toEqual(["inn_ru"]);
  });

  test("IPv4", () => {
    const r = scrubPII("server at 192.168.1.1");
    expect(r.scrubbed).toBe("server at [REDACTED:ipv4]");
    expect(r.types).toEqual(["ipv4"]);
  });

  test("address heuristic", () => {
    const r = scrubPII("live at 123 Main Street");
    expect(r.scrubbed).toBe("live at [REDACTED:address]");
    expect(r.types).toEqual(["address"]);
  });

  test("address Russian", () => {
    const r = scrubPII("проспект Ленина, 15");
    expect(r.scrubbed).toContain("[REDACTED:address]");
    expect(r.redacted_count).toBe(1);
  });

  test("mixed multiple PII types", () => {
    const r = scrubPII("Email: john@example.com, phone: +1-555-123-4567, ip: 10.0.0.1");
    expect(r.redacted_count).toBe(3);
    expect(r.types).toContain("email");
    expect(r.types).toContain("phone");
    expect(r.types).toContain("ipv4");
    expect(r.scrubbed).not.toContain("john@example.com");
    expect(r.scrubbed).not.toContain("10.0.0.1");
  });

  test("non-PII passes through unchanged", () => {
    const s = "just a normal log line with model=coder duration=123ms";
    const r = scrubPII(s);
    expect(r.scrubbed).toBe(s);
    expect(r.redacted_count).toBe(0);
    expect(r.types).toEqual([]);
  });

  test("idempotency — already redacted not double-redacted", () => {
    const s = "Contact [REDACTED:email] or [REDACTED:phone]";
    const r = scrubPII(s);
    expect(r.scrubbed).toBe(s);
    expect(r.redacted_count).toBe(0);
    expect(r.types).toEqual([]);
  });

  test("empty string", () => {
    const r = scrubPII("");
    expect(r.scrubbed).toBe("");
    expect(r.redacted_count).toBe(0);
  });
});
