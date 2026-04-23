import { describe, test, expect } from "bun:test";
import { maskSecrets } from "../src/lib/redact";

describe("maskSecrets", () => {
  test("JSON api_key", () => {
    const out = maskSecrets('{"api_key":"sk-1234567890abcdef"}');
    expect(out).toContain('***');
    expect(out).not.toContain('1234567890abcdef');
  });

  test("JSON authorization + Bearer", () => {
    const out = maskSecrets(
      '{"authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.payloadstuff.sigstuff"}',
    );
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toContain('***');
  });

  test("kebab-case KV api-key=", () => {
    const out = maskSecrets("api-key=super-secret-value-123");
    expect(out).toBe("api-key=***");
  });

  test("standalone Bearer in plain text", () => {
    const out = maskSecrets(
      "Response: Authorization: Bearer abcdef1234567890xyz",
    );
    expect(out).toContain("Bearer ***");
    expect(out).not.toContain("abcdef1234567890");
  });

  test("sk- OpenAI key", () => {
    const out = maskSecrets("token: sk-proj-abcdefghij1234567890");
    expect(out).toContain("sk-***");
    expect(out).not.toContain("abcdefghij");
  });

  test("ghp_ GitHub PAT", () => {
    const out = maskSecrets("pat: ghp_ABCDEFGHIJKLMNOPQRST0123456789");
    expect(out).toContain("ghp_***");
    expect(out).not.toContain("ABCDEFGHIJ");
  });

  test("idempotency — second pass is a no-op", () => {
    const inputs = [
      '{"api_key":"sk-1234567890abcdef"}',
      "api-key=xxx123",
      "Bearer abcdef1234567890xyz",
      "sk-proj-abcdef1234567890xyz",
      "ghp_ABCDEFGHIJKLMNOPQRSTU0123",
    ];
    for (const s of inputs) {
      const once = maskSecrets(s);
      expect(maskSecrets(once)).toBe(once);
    }
  });

  test("secret past char 200 still redacted when masked before slice", () => {
    const payload = "junk ".repeat(50) + "Bearer abcdefghijklmnop1234567890end";
    const masked = maskSecrets(payload);
    expect(masked).toContain("Bearer ***");
    expect(masked).not.toContain("abcdefghijklmnop");
  });

  test("perf on 200KB input finishes promptly", () => {
    const big =
      "lorem ipsum dolor ".repeat(10_000) +
      '{"api_key":"sk-tail1234567890"}';
    const start = Date.now();
    const out = maskSecrets(big);
    const elapsed = Date.now() - start;
    // Input is trimmed to 100KB, so tail api_key may be cut off — both
    // outcomes acceptable; main assertion is that it finishes quickly.
    expect(elapsed).toBeLessThan(500);
    expect(out.length).toBeGreaterThan(0);
  });

  test("empty string passthrough", () => {
    expect(maskSecrets("")).toBe("");
  });

  test("no secrets → unchanged", () => {
    const s = "just a normal log line with model=coder duration=123ms";
    expect(maskSecrets(s)).toBe(s);
  });
});
