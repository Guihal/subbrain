import { describe, expect, test } from "bun:test";
import {
  makeThinkSplitter,
  splitThinkTagsOnce,
  transformThinkTags,
} from "../src/providers/think-tag-transform";

describe("makeThinkSplitter — stateful incremental split", () => {
  test("full block in one feed", () => {
    const s = makeThinkSplitter();
    const r = s.feed("hello <think>reason</think>world");
    expect(r.visible).toBe("hello world");
    expect(r.thinking).toBe("reason");
  });

  test("two blocks in one feed", () => {
    const s = makeThinkSplitter();
    const r = s.feed("a<think>1</think>b<think>2</think>c");
    expect(r.visible).toBe("abc");
    expect(r.thinking).toBe("12");
  });

  test("partial open across feeds", () => {
    const s = makeThinkSplitter();
    const r1 = s.feed("<thi");
    expect(r1.visible).toBe("");
    expect(r1.thinking).toBe("");
    const r2 = s.feed("nk>mid</think>end");
    expect(r2.visible).toBe("end");
    expect(r2.thinking).toBe("mid");
  });

  test("partial close across feeds", () => {
    const s = makeThinkSplitter();
    const r1 = s.feed("<think>partial");
    expect(r1.visible).toBe("");
    expect(r1.thinking).toBe("partial");
    const r2 = s.feed(" more</thi");
    expect(r2.visible).toBe("");
    expect(r2.thinking).toBe(" more");
    const r3 = s.feed("nk>tail");
    expect(r3.visible).toBe("tail");
    expect(r3.thinking).toBe("");
  });

  test("literal angle brackets outside think are not eaten", () => {
    const s = makeThinkSplitter();
    const r = s.feed("x</think>y");
    expect(r.visible).toBe("x</think>y");
    expect(r.thinking).toBe("");
  });

  test("unclosed block at end of stream — thinking accumulates, nothing visible yet", () => {
    const s = makeThinkSplitter();
    const r1 = s.feed("visible <think>halfway");
    expect(r1.visible).toBe("visible ");
    expect(r1.thinking).toBe("halfway");
    const r2 = s.feed(" still-thinking");
    expect(r2.visible).toBe("");
    expect(r2.thinking).toBe(" still-thinking");
  });

  test("partial-looking tail that is not a real tag prefix is flushed", () => {
    const s = makeThinkSplitter();
    // "<x" looks like it could start a tag prefix, but "<" is only tag-prefix
    // when next char matches "think>" or similar. Simpler check: only buffer
    // if the tail is actually a prefix of "<think>".
    const r = s.feed("foo<x");
    expect(r.visible).toBe("foo<x");
    expect(r.thinking).toBe("");
  });
});

describe("splitThinkTagsOnce — non-stream one-shot", () => {
  test("null passthrough", () => {
    expect(splitThinkTagsOnce(null)).toEqual({ visible: null, thinking: "" });
  });

  test("no tags passthrough (trim)", () => {
    const r = splitThinkTagsOnce("  hello  ");
    expect(r.visible).toBe("hello");
    expect(r.thinking).toBe("");
  });

  test("strips think, concatenates reasoning", () => {
    const r = splitThinkTagsOnce("a<think>one</think>b<think>two</think>c");
    expect(r.visible).toBe("abc");
    expect(r.thinking).toBe("onetwo");
  });

  test("all-think returns null visible", () => {
    const r = splitThinkTagsOnce("<think>only</think>");
    expect(r.visible).toBeNull();
    expect(r.thinking).toBe("only");
  });
});

describe("transformThinkTags — SSE stream rewriter", () => {
  function toStream(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
  }

  async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
    const dec = new TextDecoder();
    const r = s.getReader();
    let out = "";
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
    return out;
  }

  function dataLine(delta: Record<string, unknown>): string {
    return `data: ${JSON.stringify({ choices: [{ delta, index: 0, finish_reason: null }] })}\n\n`;
  }

  test("passes through [DONE] and non-data lines untouched", async () => {
    const input = [": ping\n\n", dataLine({ content: "hi" }), "data: [DONE]\n\n"];
    const out = await readAll(transformThinkTags(toStream(input)));
    expect(out).toContain(": ping\n\n");
    expect(out).toContain("data: [DONE]\n\n");
    const dataLines = out.split("\n").filter((l) => l.startsWith("data: {"));
    expect(dataLines.length).toBe(1);
    const parsed = JSON.parse(dataLines[0]?.slice(6));
    expect(parsed.choices[0].delta.content).toBe("hi");
    expect(parsed.choices[0].delta.reasoning_content).toBeUndefined();
  });

  test("moves think-tagged content to reasoning_content", async () => {
    const input = [dataLine({ content: "vis <think>reason</think>end" })];
    const out = await readAll(transformThinkTags(toStream(input)));
    const parsed = JSON.parse(
      out
        .split("\n")
        .filter((l) => l.startsWith("data: {"))[0]
        ?.slice(6),
    );
    expect(parsed.choices[0].delta.content).toBe("vis end");
    expect(parsed.choices[0].delta.reasoning_content).toBe("reason");
  });

  test("partial tag straddles SSE frames", async () => {
    const input = [dataLine({ content: "open<thi" }), dataLine({ content: "nk>mid</think>tail" })];
    const out = await readAll(transformThinkTags(toStream(input)));
    const chunks = out
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)));
    // First chunk: "open" visible, "<thi" buffered.
    expect(chunks[0].choices[0].delta.content).toBe("open");
    expect(chunks[0].choices[0].delta.reasoning_content).toBeUndefined();
    // Second chunk: "tail" visible, "mid" thinking.
    expect(chunks[1].choices[0].delta.content).toBe("tail");
    expect(chunks[1].choices[0].delta.reasoning_content).toBe("mid");
  });

  test("merges with existing reasoning_content field", async () => {
    const input = [dataLine({ content: "<think>inline</think>", reasoning_content: "pre-" })];
    const out = await readAll(transformThinkTags(toStream(input)));
    const parsed = JSON.parse(
      out
        .split("\n")
        .filter((l) => l.startsWith("data: {"))[0]
        ?.slice(6),
    );
    expect(parsed.choices[0].delta.content).toBe("");
    expect(parsed.choices[0].delta.reasoning_content).toBe("pre-inline");
  });

  test("chunks split mid-JSON reassemble correctly", async () => {
    const full = dataLine({ content: "a<think>b</think>c" });
    const mid = Math.floor(full.length / 2);
    const input = [full.slice(0, mid), full.slice(mid)];
    const out = await readAll(transformThinkTags(toStream(input)));
    const parsed = JSON.parse(
      out
        .split("\n")
        .filter((l) => l.startsWith("data: {"))[0]
        ?.slice(6),
    );
    expect(parsed.choices[0].delta.content).toBe("ac");
    expect(parsed.choices[0].delta.reasoning_content).toBe("b");
  });
});
