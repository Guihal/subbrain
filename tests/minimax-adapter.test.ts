import { describe, test, expect } from "bun:test";
import type { Message, ChatResponse } from "../src/providers/types";
import {
  rewrapHistoryForMinimax,
  splitResponseThinkTags,
  MiniMaxProvider,
} from "../src/providers/minimax";
import { ProviderError } from "../src/providers/nvidia";

describe("rewrapHistoryForMinimax", () => {
  test("preserves non-assistant messages as-is", () => {
    const msgs: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "tool", content: "{}", tool_call_id: "t1" },
    ];
    expect(rewrapHistoryForMinimax(msgs)).toEqual(msgs);
  });

  test("wraps assistant reasoning_content back into <think> and strips field", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: "answer",
        reasoning_content: "internal",
      },
    ];
    const out = rewrapHistoryForMinimax(msgs);
    expect(out[0]).toEqual({
      role: "assistant",
      content: "<think>internal</think>\nanswer",
    });
    expect("reasoning_content" in out[0]!).toBe(false);
  });

  test("handles null content + reasoning_content", () => {
    const msgs: Message[] = [
      { role: "assistant", content: null, reasoning_content: "x" },
    ];
    const out = rewrapHistoryForMinimax(msgs);
    expect(out[0]).toEqual({
      role: "assistant",
      content: "<think>x</think>\n",
    });
  });

  test("assistant without reasoning_content unchanged (except field absence)", () => {
    const msgs: Message[] = [
      { role: "assistant", content: "plain" },
    ];
    const out = rewrapHistoryForMinimax(msgs);
    expect(out[0]).toEqual({ role: "assistant", content: "plain" });
  });

  test("preserves tool_calls on wrapped assistant", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: "using tool",
        reasoning_content: "plan",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "x", arguments: "{}" } },
        ],
      },
    ];
    const out = rewrapHistoryForMinimax(msgs);
    expect(out[0]!.content).toBe("<think>plan</think>\nusing tool");
    expect(out[0]!.tool_calls).toBeDefined();
    expect(out[0]!.tool_calls!.length).toBe(1);
  });
});

describe("splitResponseThinkTags", () => {
  function fakeResp(content: string | null): ChatResponse {
    return {
      id: "r",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    };
  }

  test("no tags — returns original object reference", () => {
    const r = fakeResp("just a plain answer");
    const out = splitResponseThinkTags(r);
    expect(out).toBe(r);
  });

  test("splits single block", () => {
    const out = splitResponseThinkTags(
      fakeResp("<think>hidden</think>visible"),
    );
    expect(out.choices[0]!.message.content).toBe("visible");
    expect(out.choices[0]!.message.reasoning_content).toBe("hidden");
  });

  test("concatenates with upstream reasoning_content if present", () => {
    const r = fakeResp("<think>b</think>end");
    r.choices[0]!.message.reasoning_content = "a";
    const out = splitResponseThinkTags(r);
    expect(out.choices[0]!.message.reasoning_content).toBe("ab");
    expect(out.choices[0]!.message.content).toBe("end");
  });

  test("whole content is think → visible null, reasoning set", () => {
    const out = splitResponseThinkTags(fakeResp("<think>only</think>"));
    expect(out.choices[0]!.message.content).toBeNull();
    expect(out.choices[0]!.message.reasoning_content).toBe("only");
  });
});

describe("MiniMaxProvider.chat quota error mapping", () => {
  function makeProviderWithInner(innerResp: unknown): MiniMaxProvider {
    const p = new MiniMaxProvider("http://x", "k");
    (p as unknown as { inner: { chat: () => Promise<unknown> } }).inner = {
      chat: () => Promise.resolve(innerResp),
    };
    return p;
  }

  test("status_code 2056 (weekly quota) → ProviderError 429, fallback can trigger", async () => {
    const p = makeProviderWithInner({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "MiniMax-M2",
      choices: null,
      base_resp: {
        status_code: 2056,
        status_msg: "weekly usage limit reached (15000/15000)",
      },
    });
    await expect(
      p.chat({ model: "MiniMax-M2.7", messages: [] }),
    ).rejects.toBeInstanceOf(ProviderError);
    try {
      await p.chat({ model: "MiniMax-M2.7", messages: [] });
    } catch (e) {
      expect((e as ProviderError).status).toBe(429);
    }
  });

  test("non-zero status_code (generic error) → ProviderError 502", async () => {
    const p = makeProviderWithInner({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "MiniMax-M2",
      choices: null,
      base_resp: { status_code: 1004, status_msg: "auth failed" },
    });
    try {
      await p.chat({ model: "MiniMax-M2.7", messages: [] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).status).toBe(502);
    }
  });

  test("missing choices without base_resp → ProviderError 502", async () => {
    const p = makeProviderWithInner({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "MiniMax-M2",
      choices: null,
    });
    await expect(
      p.chat({ model: "MiniMax-M2.7", messages: [] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  test("valid response (status_code 0) passes through unchanged", async () => {
    const p = makeProviderWithInner({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "MiniMax-M2",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      base_resp: { status_code: 0, status_msg: "success" },
    });
    const out = await p.chat({ model: "MiniMax-M2.7", messages: [] });
    expect(out.choices[0]!.message.content).toBe("ok");
  });
});
