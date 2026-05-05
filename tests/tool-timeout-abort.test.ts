/**
 * CANCEL-1 / PR 20 — `withToolTimeout` must fire its internal AbortController
 * when the timeout elapses, so long-running handlers stop eating upstream
 * resources instead of running to their natural end.
 */
import { describe, expect, test } from "bun:test";
import { withToolTimeout } from "@subbrain/agent/pipeline/agent-loop/tool-runner";

describe("withToolTimeout", () => {
  test("timeout fires internal abort; handler sees signal.aborted=true", async () => {
    let observedAborted = false;
    let finished = false;
    const start = Date.now();

    const result = await withToolTimeout(
      "web_dummy",
      async (signal) => {
        // Poll the signal every 50ms for up to 20s.
        return await new Promise<string>((resolve) => {
          const iv = setInterval(() => {
            if (signal.aborted) {
              observedAborted = true;
              clearInterval(iv);
              // Return *something* — tool-runner ignores it because timeout won.
              resolve("should-never-surface");
            }
          }, 50);
          setTimeout(() => {
            clearInterval(iv);
            finished = true;
            resolve("slow-handler-done");
          }, 20_000);
        });
      },
      undefined,
      500, // override timeout: 500ms
    );

    const elapsed = Date.now() - start;

    // Tool-runner wins the race — result is the timeout envelope.
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result as string);
    expect(parsed).toEqual({
      error: { code: "timeout", name: "web_dummy", timeout_ms: 500 },
    });
    expect(elapsed).toBeLessThan(700);

    // Handler eventually sees the abort (give the poller one more tick).
    await new Promise((r) => setTimeout(r, 150));
    expect(observedAborted).toBe(true);
    expect(finished).toBe(false);
  });

  test("external signal aborts exec too (composition)", async () => {
    const external = new AbortController();
    let observedAborted = false;

    const p = withToolTimeout(
      "web_dummy",
      async (signal) => {
        return await new Promise<string>((resolve) => {
          const iv = setInterval(() => {
            if (signal.aborted) {
              observedAborted = true;
              clearInterval(iv);
              resolve("aborted");
            }
          }, 50);
          setTimeout(() => {
            clearInterval(iv);
            resolve("slow-handler-done");
          }, 20_000);
        });
      },
      external.signal,
      10_000, // long tool-timeout — external wins
    );

    setTimeout(() => external.abort(), 200);

    const result = await p;
    // External abort makes exec resolve quickly — tool-runner returns that
    // value directly (not the timeout sentinel), so the raw "aborted" string
    // comes back.
    expect(result).toBe("aborted");
    expect(observedAborted).toBe(true);
  });

  test("handler completes before timeout: returns its value", async () => {
    const res = await withToolTimeout("web_dummy", async () => "fast-result", undefined, 500);
    expect(res).toBe("fast-result");
  });
});
