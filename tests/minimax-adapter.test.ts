import { describe, test, expect } from "bun:test";
import type { Message, ChatResponse } from "../src/providers/types";
import {
  rewrapHistoryForMinimax,
  splitResponseThinkTags,
} from "../src/providers/minimax";

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
