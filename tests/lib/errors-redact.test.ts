import { describe, test, expect } from "bun:test";
import { redactSecrets, HttpError } from "../../src/lib/errors";

describe("redactSecrets", () => {
  test("strips Bearer + ghu_ + sk- + nvapi-", () => {
    const dirty =
      "auth Bearer ghu_aaaaaaaaaaaaaaaaaaaa and sk-1234567890abcdefghij and nvapi-zzzzzzzzzzzz";
    const clean = redactSecrets(dirty);
    expect(clean).not.toMatch(/ghu_/);
    expect(clean).not.toMatch(/sk-1/);
    expect(clean).not.toMatch(/nvapi-z/);
    expect(clean).toContain("[REDACTED]");
  });

  test("HttpError: BOTH .message AND .body redacted", () => {
    const e = new HttpError(
      401,
      '{"err":"Bearer ghu_aaaaaaaaaaaaaaaaaaaa"}',
      { url: "x" },
    );
    expect(e.message).not.toMatch(/ghu_/);
    expect(e.body).not.toMatch(/ghu_/);
  });
});
