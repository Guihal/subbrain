import * as vscode from "vscode";

// ─── Model registry ───────────────────────────────────────────────────────────

interface SubbrainModel {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
}

const SUBBRAIN_MODELS: SubbrainModel[] = [
  {
    id: "teamlead",
    name: "Тимлид (Claude Opus 4.6)",
    contextWindow: 200_000,
    maxOutput: 16_384,
    supportsTools: true,
  },
  {
    id: "coder",
    name: "Кодер (Claude Sonnet 4.6)",
    contextWindow: 200_000,
    maxOutput: 16_384,
    supportsTools: true,
  },
  {
    id: "critic",
    name: "Критик (Gemini 3.1 Pro)",
    contextWindow: 200_000,
    maxOutput: 16_384,
    supportsTools: true,
  },
  {
    id: "generalist",
    name: "Генералист (Claude Sonnet 4.6)",
    contextWindow: 200_000,
    maxOutput: 16_384,
    supportsTools: true,
  },
  {
    id: "flash",
    name: "Флэш (GPT 5.4 Mini)",
    contextWindow: 128_000,
    maxOutput: 16_384,
    supportsTools: true,
  },
  {
    id: "chaos",
    name: "Хаос (GPT 5.4 Mini)",
    contextWindow: 128_000,
    maxOutput: 16_384,
    supportsTools: false,
  },
];

// ─── OpenAI-compatible message types ─────────────────────────────────────────

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface StreamDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface StreamChunk {
  choices?: Array<{
    delta: StreamDelta;
    finish_reason: string | null;
  }>;
}

// ─── Message conversion ───────────────────────────────────────────────────────

/**
 * Safe text extractor — handles both .value (VS Code 1.100+) and .text (legacy).
 */
function getTextValue(part: unknown): string | undefined {
  if (part instanceof vscode.LanguageModelTextPart) return part.value;
  const p = part as Record<string, unknown>;
  if (typeof p?.value === "string") return p.value;
  if (typeof p?.text === "string") return p.text;
  return undefined;
}

function isToolCallPart(
  part: unknown,
): part is vscode.LanguageModelToolCallPart {
  return (
    part instanceof vscode.LanguageModelToolCallPart ||
    (typeof (part as Record<string, unknown>)?.callId === "string" &&
      typeof (part as Record<string, unknown>)?.name === "string" &&
      (part as Record<string, unknown>)?.input !== undefined)
  );
}

function isToolResultPart(
  part: unknown,
): part is vscode.LanguageModelToolResultPart {
  return (
    part instanceof vscode.LanguageModelToolResultPart ||
    (typeof (part as Record<string, unknown>)?.callId === "string" &&
      Array.isArray((part as Record<string, unknown>)?.content))
  );
}

/**
 * Converts VS Code LanguageModelChatMessage[] → OpenAI messages[].
 *
 * VS Code bundles tool results inside user-role messages; OpenAI expects
 * them as separate `role: "tool"` entries. We expand them here.
 *
 * The FIRST user message from Copilot Chat is typically the system prompt
 * (instructions, skills, agents). We convert it to role:"system" so the
 * Subbrain pipeline can properly distinguish it from real user queries.
 */
function convertMessages(
  messages: readonly vscode.LanguageModelChatMessage[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  let firstUserSeen = false;

  for (const msg of messages) {
    const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;

    if (isUser) {
      const textParts: string[] = [];
      const toolResults: vscode.LanguageModelToolResultPart[] = [];

      for (const part of msg.content) {
        const txt = getTextValue(part);
        if (txt !== undefined) {
          textParts.push(txt);
        } else if (isToolResultPart(part)) {
          toolResults.push(part);
        }
      }

      // Tool results → separate OpenAI "tool" messages
      for (const tr of toolResults) {
        const content = tr.content.map((p) => getTextValue(p) ?? "").join("");
        result.push({ role: "tool", tool_call_id: tr.callId, content });
      }

      if (textParts.length > 0) {
        const content = textParts.join("\n");
        // First user message with no tool results is the Copilot system prompt
        if (!firstUserSeen && toolResults.length === 0) {
          firstUserSeen = true;
          result.push({ role: "system", content });
        } else {
          result.push({ role: "user", content });
        }
      }
    } else {
      // Assistant message
      const textParts: string[] = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];

      for (const part of msg.content) {
        const txt = getTextValue(part);
        if (txt !== undefined) {
          textParts.push(txt);
        } else if (isToolCallPart(part)) {
          toolCalls.push(part);
        }
      }

      if (toolCalls.length > 0) {
        result.push({
          role: "assistant",
          content: textParts.join("\n") || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.callId,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          })),
        });
      } else {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
    }
  }

  return result;
}

// ─── SSE stream processor ─────────────────────────────────────────────────────

async function processStream(
  body: ReadableStream<Uint8Array>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
): Promise<void> {
  if (typeof body?.getReader !== "function") {
    throw new Error(
      `[Subbrain] response.body has no getReader(): ${typeof body}`,
    );
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Buffers for streaming tool call assembly (streamed in chunks by index)
  const toolCallBuffers = new Map<
    number,
    { id?: string; name?: string; args: string }
  >();
  const completedIndices = new Set<number>();

  const tryEmit = (idx: number) => {
    const buf = toolCallBuffers.get(idx);
    if (!buf?.name) return;
    try {
      const input = JSON.parse(buf.args) as Record<string, unknown>;
      const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
      progress.report(
        new vscode.LanguageModelToolCallPart(id, buf.name, input),
      );
      toolCallBuffers.delete(idx);
      completedIndices.add(idx);
    } catch {
      // JSON not yet complete — keep buffering
    }
  };

  const flushAll = () => {
    for (const [idx, buf] of toolCallBuffers.entries()) {
      if (!buf.name) continue;
      try {
        const input = JSON.parse(buf.args || "{}") as Record<string, unknown>;
        const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
        progress.report(
          new vscode.LanguageModelToolCallPart(id, buf.name, input),
        );
      } catch {
        // Drop incomplete / invalid tool call
      }
      toolCallBuffers.delete(idx);
      completedIndices.add(idx);
    }
  };

  let totalTextChars = 0;
  let totalChunks = 0;
  let firstChunkLogged = false;

  try {
    while (!token.isCancellationRequested) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();

        if (data === "[DONE]") {
          flushAll();
          console.log(
            `[Subbrain] Stream DONE: ${totalChunks} chunks, ${totalTextChars} text chars, ${toolCallBuffers.size} pending tool calls`,
          );
          continue;
        }

        try {
          const chunk = JSON.parse(data) as StreamChunk & {
            error?: { message?: string; type?: string };
          };
          totalChunks++;

          // Log first chunk for debugging
          if (!firstChunkLogged) {
            console.log(`[Subbrain] First chunk: ${data.slice(0, 300)}`);
            firstChunkLogged = true;
          }

          // Handle upstream error chunks from Subbrain proxy
          if (chunk.error) {
            const errMsg = chunk.error.message || "Unknown upstream error";
            console.error(`[Subbrain] Stream error chunk: ${errMsg}`);
            throw new Error(`Subbrain upstream error: ${errMsg}`);
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Text content
          if (delta?.content) {
            totalTextChars += delta.content.length;
            progress.report(new vscode.LanguageModelTextPart(delta.content));
          }

          // Reasoning/thinking content — show as italic text so user sees the process
          if (delta?.reasoning_content) {
            progress.report(
              new vscode.LanguageModelTextPart(delta.reasoning_content),
            );
          }

          // Streaming tool calls (assembled by index)
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (completedIndices.has(idx)) continue;

              const buf = toolCallBuffers.get(idx) ?? { args: "" };
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name = tc.function.name;
              if (typeof tc.function?.arguments === "string")
                buf.args += tc.function.arguments;
              toolCallBuffers.set(idx, buf);

              tryEmit(idx);
            }
          }

          if (
            choice.finish_reason === "tool_calls" ||
            choice.finish_reason === "stop"
          ) {
            flushAll();
          }
        } catch {
          // Ignore malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class SubbrainChatModelProvider
  implements vscode.LanguageModelChatProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  fireModelInfoChanged(): void {
    this._onDidChange.fire();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // Return all models regardless of token state so they appear in picker.
    // Actual auth failure happens in provideLanguageModelChatResponse.
    return SUBBRAIN_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      family: "subbrain",
      version: "1.0.0",
      maxInputTokens: m.contextWindow - m.maxOutput,
      maxOutputTokens: m.maxOutput,
      capabilities: {
        toolCalling: m.supportsTools ? (128 as number | false) : false,
        imageInput: false,
      },
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const authToken = await this.secrets.get("subbrain.token");
    if (!authToken) {
      throw vscode.LanguageModelError.NoPermissions(
        "Subbrain token not set. Run command: Subbrain: Manage Subbrain Provider",
      );
    }

    const baseUrl = vscode.workspace
      .getConfiguration("subbrain")
      .get<string>("baseUrl", "https://subbrain.dmtr.ru/v1");

    const convertedMessages = convertMessages(messages);
    const body: Record<string, unknown> = {
      model: model.id,
      messages: convertedMessages,
      stream: true,
    };

    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.inputSchema ?? { type: "object", properties: {} },
        },
      }));
      body.tool_choice = "auto";
    }

    // Debug: log outgoing request shape
    console.log(
      `[Subbrain] REQUEST model=${model.id} msgs=${convertedMessages.length} tools=${options.tools?.length ?? 0}`,
    );
    console.log(
      `[Subbrain] Messages: ${JSON.stringify(convertedMessages.map((m: any) => ({ role: m.role, contentLen: typeof m.content === "string" ? m.content.length : m.content, hasTool: !!m.tool_call_id || !!m.tool_calls })))}`,
    );

    const abortController = new AbortController();
    const unsub = token.onCancellationRequested(() => abortController.abort());

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      console.log(
        `[Subbrain] RESPONSE status=${response.status} content-type=${response.headers.get("content-type")}`,
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Subbrain] ERROR response: ${errorText.slice(0, 500)}`);
        if (response.status === 401 || response.status === 403) {
          throw vscode.LanguageModelError.NoPermissions(
            `Subbrain auth error (${response.status}): ${errorText}`,
          );
        }
        throw new Error(`Subbrain API error ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error("No response body from Subbrain API");
      }

      console.log(
        `[Subbrain] Streaming from ${baseUrl}/chat/completions, status=${response.status}`,
      );
      await processStream(response.body, progress, token);
    } catch (err) {
      if (
        token.isCancellationRequested ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        throw new vscode.CancellationError();
      }
      throw err;
    } finally {
      unsub.dispose();
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | { content: readonly unknown[] },
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") {
      return Promise.resolve(Math.ceil(text.length / 4));
    }
    // Rough estimate for structured content
    return Promise.resolve(Math.ceil(JSON.stringify(text).length / 4));
  }
}
