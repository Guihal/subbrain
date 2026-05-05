/**
 * Normalize `<think>...</think>` reasoning embedded in SSE `delta.content`
 * (MiniMax-M2 convention) into OpenAI-style `delta.reasoning_content`.
 *
 * The transform is stateful across chunks — `<think>` / `</think>` tags can
 * straddle chunk boundaries. Non-think chunks pass through with JSON
 * re-serialization; malformed/non-data SSE lines pass through byte-for-byte.
 *
 * Apply unconditionally per request; no-op when upstream emits no think tags.
 */

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

export interface ThinkSplitter {
  feed(delta: string): { visible: string; thinking: string };
}

/** Length of the longest suffix of `buf` that is a prefix of `tag`. */
function tagPrefixSuffixLen(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(buf.slice(buf.length - len))) return len;
  }
  return 0;
}

export function makeThinkSplitter(): ThinkSplitter {
  let inThink = false;
  let carry = "";

  function feed(delta: string): { visible: string; thinking: string } {
    let buf = carry + delta;
    carry = "";
    let visible = "";
    let thinking = "";

    while (buf.length > 0) {
      if (inThink) {
        const close = buf.indexOf(CLOSE_TAG);
        if (close === -1) {
          const hold = tagPrefixSuffixLen(buf, CLOSE_TAG);
          thinking += buf.slice(0, buf.length - hold);
          carry = buf.slice(buf.length - hold);
          return { visible, thinking };
        }
        thinking += buf.slice(0, close);
        buf = buf.slice(close + CLOSE_TAG.length);
        inThink = false;
      } else {
        const open = buf.indexOf(OPEN_TAG);
        if (open === -1) {
          const hold = tagPrefixSuffixLen(buf, OPEN_TAG);
          visible += buf.slice(0, buf.length - hold);
          carry = buf.slice(buf.length - hold);
          return { visible, thinking };
        }
        visible += buf.slice(0, open);
        buf = buf.slice(open + OPEN_TAG.length);
        inThink = true;
      }
    }
    return { visible, thinking };
  }

  return { feed };
}

/**
 * Non-stream one-shot split — for `chat()` response bodies where the whole
 * message content is available at once.
 */
export function splitThinkTagsOnce(content: string | null): {
  visible: string | null;
  thinking: string;
} {
  if (!content) return { visible: content, thinking: "" };
  let thinking = "";
  const visible = content.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner) => {
    thinking += inner;
    return "";
  });
  const trimmed = visible.trim();
  return { visible: trimmed.length > 0 ? trimmed : null, thinking };
}

/**
 * Wrap an SSE byte stream; rewrites `delta.content` → `delta.reasoning_content`
 * for think-tagged segments while leaving every other byte untouched.
 */
export function transformThinkTags(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const splitter = makeThinkSplitter();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            controller.enqueue(encoder.encode(`${transformLine(line, splitter)}\n`));
          }
        }
        if (buffer.length > 0) {
          controller.enqueue(encoder.encode(transformLine(buffer, splitter)));
        }
        controller.close();
      } catch (err) {
        try {
          controller.error(err);
        } catch {
          /* already errored/closed */
        }
      }
    },
  });
}

function transformLine(line: string, splitter: ThinkSplitter): string {
  if (!line.startsWith("data: ")) return line;
  const data = line.slice(6).trim();
  if (!data || data === "[DONE]") return line;

  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return line;
  }

  const chunk = json as {
    choices?: Array<{
      delta?: { content?: unknown; reasoning_content?: unknown };
    }>;
  };
  const delta = chunk.choices?.[0]?.delta;
  if (!delta || typeof delta.content !== "string") return line;

  const { visible, thinking } = splitter.feed(delta.content);
  delta.content = visible;
  if (thinking) {
    const prior = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    delta.reasoning_content = prior + thinking;
  }
  return `data: ${JSON.stringify(chunk)}`;
}
