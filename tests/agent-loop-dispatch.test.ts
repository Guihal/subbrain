import { describe, expect, test } from "bun:test";
import {
  type NormalizedCall,
  normalizeToolCalls,
} from "@subbrain/agent/pipeline/agent-loop/tool-dispatch";

describe("normalizeToolCalls", () => {
  test("OpenAI flavor: {id, function:{name, arguments}}", () => {
    const raw = [
      {
        id: "call_1",
        type: "function",
        function: { name: "memory_search", arguments: '{"q":"foo"}' },
      },
    ];
    const got = normalizeToolCalls(raw);
    expect(got).toEqual([
      { id: "call_1", name: "memory_search", args: '{"q":"foo"}' },
    ] satisfies NormalizedCall[]);
  });

  test("Anthropic flavor: {type:'tool_use', id, name, input}", () => {
    const raw = [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "memory_search",
        input: { q: "foo" },
      },
    ];
    const got = normalizeToolCalls(raw);
    expect(got).toEqual([
      { id: "toolu_1", name: "memory_search", args: '{"q":"foo"}' },
    ] satisfies NormalizedCall[]);
  });

  test("mixed flavors produce the same NormalizedCall[]", () => {
    const oa = normalizeToolCalls([
      {
        id: "1",
        type: "function",
        function: { name: "done", arguments: '{"summary":"ok"}' },
      },
    ]);
    const an = normalizeToolCalls([
      { type: "tool_use", id: "1", name: "done", input: { summary: "ok" } },
    ]);
    expect(oa).toEqual(an);
  });

  test("ignores junk / missing fields", () => {
    const got = normalizeToolCalls([null, {}, { function: {} }, { type: "tool_use" }]);
    expect(got).toEqual([]);
  });

  test("non-array input returns empty array", () => {
    expect(normalizeToolCalls(undefined)).toEqual([]);
    expect(normalizeToolCalls(null)).toEqual([]);
    expect(normalizeToolCalls("{}")).toEqual([]);
  });

  test("Anthropic input without args → '{}'", () => {
    const got = normalizeToolCalls([{ type: "tool_use", id: "x", name: "ping" }]);
    expect(got).toEqual([{ id: "x", name: "ping", args: "{}" }]);
  });
});
