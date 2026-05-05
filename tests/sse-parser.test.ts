import { describe, expect, test } from "bun:test";
import { assembleMessage, parseSSEChunk } from "../src/providers/sse-parser";

describe("parseSSEChunk", () => {
  test("parses content delta", () => {
    const result = parseSSEChunk(
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
    );
    expect(result?.content).toBe("hi");
  });

  test("returns null for [DONE]", () => {
    expect(parseSSEChunk("data: [DONE]")).toBeNull();
  });

  test("returns null for heartbeat ping", () => {
    expect(parseSSEChunk(": ping")).toBeNull();
  });

  test("returns null for empty line", () => {
    expect(parseSSEChunk("")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseSSEChunk("data: invalid json")).toBeNull();
  });

  test("parses reasoning_content separately from content", () => {
    const result = parseSSEChunk(
      'data: {"choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}',
    );
    expect(result?.reasoning_content).toBe("think");
    expect(result?.content).toBeUndefined();
  });

  test("parses finish_reason", () => {
    const result = parseSSEChunk('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}');
    expect(result?.finish_reason).toBe("stop");
  });

  test("returns null when no choices", () => {
    expect(parseSSEChunk('data: {"id":"x","object":"chat.completion.chunk"}')).toBeNull();
  });
});

describe("assembleMessage", () => {
  test("accumulates content from multiple deltas", () => {
    const result = assembleMessage([{ content: "hello" }, { content: " world" }]);
    expect(result.content).toBe("hello world");
  });

  test("content is null when all deltas have no content", () => {
    const result = assembleMessage([{ reasoning_content: "thinking" }]);
    expect(result.content).toBeNull();
  });

  test("reasoning_content stays separate from content", () => {
    const result = assembleMessage([{ content: "answer", reasoning_content: "thought" }]);
    expect(result.content).toBe("answer");
    expect(result.reasoning_content).toBe("thought");
  });

  test("tool_calls arguments accumulated by index", () => {
    const result = assembleMessage([
      {
        tool_calls: [{ index: 0, id: "call1", function: { name: "foo", arguments: '{"a":' } }],
      },
      { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
      { tool_calls: [{ index: 0, function: { arguments: "" } }] },
    ]);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0].function.arguments).toBe('{"a":1}');
  });

  test("tool_calls absent when no tool deltas", () => {
    const result = assembleMessage([{ content: "hello" }]);
    expect(result.tool_calls).toBeUndefined();
  });

  test("content null with tool_calls present", () => {
    const result = assembleMessage([
      {
        tool_calls: [{ index: 0, id: "c1", function: { name: "bar", arguments: "{}" } }],
      },
    ]);
    expect(result.content).toBeNull();
    expect(result.tool_calls).toHaveLength(1);
  });

  test("role is always assistant", () => {
    expect(assembleMessage([]).role).toBe("assistant");
  });
});
