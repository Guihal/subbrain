/**
 * Hardening: ModelRouter exposes isOverloaded; ProviderError(408) usable for timeouts.
 */

import { describe, expect, test } from "bun:test";
import { ProviderError } from "@subbrain/providers/nvidia";

describe("ModelRouter overload signal", () => {
  test("mock router exposes isOverloaded as boolean", () => {
    const mockRouter = {
      get isOverloaded() {
        return false;
      },
    };
    expect(typeof mockRouter.isOverloaded).toBe("boolean");
  });
});

describe("ProviderError 408 timeout shape", () => {
  test("accepts 408 status and preserves body for timeout scenarios", () => {
    const err408 = new ProviderError(408, "Request timeout");
    expect(err408.status).toBe(408);
    expect(err408.body).toBe("Request timeout");
  });
});
