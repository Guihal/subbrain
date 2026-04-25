import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { OpenAICompatProvider } from "../../src/providers/openai-compat";
import { ProviderError } from "../../src/providers/nvidia";
import type { Message } from "../../src/providers/types";
import type { ModelRoute } from "../../src/lib/model-map";

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
type Hit = { url: string; method: string; headers: Headers; body: string };
const hits: Hit[] = [];
let nextStatus = 200;
let nextBody: string | null = null;
let slowMs = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      hits.push({ url: url.pathname, method: req.method, headers: req.headers, body });
      if (slowMs > 0) await Bun.sleep(slowMs);
      if (nextStatus !== 200) return new Response(nextBody ?? "boom", { status: nextStatus });
      if (url.pathname === "/v1/chat/completions") {
        if (body.includes('"stream":true')) {
          const sse =
            'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
          return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({
          id: "r1", object: "chat.completion", created: 0, model: "gpt-5.5",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        });
      }
      if (url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "gpt-5.5", object: "model", created: 0, owned_by: "openai" }] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}/v1`;
});
afterAll(() => server.stop(true));

function reset() { hits.length = 0; nextStatus = 200; nextBody = null; slowMs = 0; }

const msg: Message[] = [{ role: "user", content: "hi" }];

describe("OpenAICompatProvider", () => {
  test("chat: posts to configured base URL", async () => {
    reset();
    const p = new OpenAICompatProvider(baseUrl, "key");
    await p.chat({ model: "gpt-5.5", messages: msg });
    expect(hits.length).toBe(1);
    expect(hits[0]!.url).toBe("/v1/chat/completions");
    expect(hits[0]!.method).toBe("POST");
  });

  test("chat: Bearer auth header", async () => {
    reset();
    const p = new OpenAICompatProvider(baseUrl, "secret-token");
    await p.chat({ model: "gpt-5.5", messages: msg });
    expect(hits[0]!.headers.get("authorization")).toBe("Bearer secret-token");
  });

  test("chat: X-Subbrain-Provider: openai-compat header", async () => {
    reset();
    const p = new OpenAICompatProvider(baseUrl, "k");
    await p.chat({ model: "gpt-5.5", messages: msg });
    expect(hits[0]!.headers.get("x-subbrain-provider")).toBe("openai-compat");
  });

  test("chatStream: returns ReadableStream", async () => {
    reset();
    const p = new OpenAICompatProvider(baseUrl, "k");
    const stream = p.chatStream({
      model: "gpt-5.5",
      messages: msg,
      stream: true,
    });
    expect(stream).toBeInstanceOf(ReadableStream);
    const reader = stream.getReader();
    let total = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += new TextDecoder().decode(value);
    }
    expect(total).toContain("[DONE]");
  });

  test("chat: AbortSignal cancels in-flight", async () => {
    reset();
    slowMs = 500;
    const p = new OpenAICompatProvider(baseUrl, "k");
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    let caught: unknown;
    try {
      await p.chat({ model: "gpt-5.5", messages: msg, signal: ctrl.signal });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
  });

  test("chat: 4xx body NOT leak Bearer/ghu_ in error", async () => {
    reset();
    nextStatus = 401;
    nextBody = '{"error":"Bearer ghu_aaaaaaaaaaaaaaaaaaaa rejected"}';
    const p = new OpenAICompatProvider(baseUrl, "k");
    let caught: unknown;
    try {
      await p.chat({ model: "gpt-5.5", messages: msg });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.message).not.toMatch(/ghu_/);
    expect(err.message).not.toMatch(/Bearer ghu/);
    expect(err.body).not.toMatch(/ghu_/);
  });

  test("listModels: passthrough /v1/models", async () => {
    reset();
    const p = new OpenAICompatProvider(baseUrl, "k");
    const out = await p.listModels();
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("gpt-5.5");
    expect(hits[0]!.url).toBe("/v1/models");
  });
});

describe("model-map: detect + apply", () => {
  afterEach(() => {
    delete process.env.OPENAI_COMPAT_ENABLED;
  });

  test("detect: gpt-5.5 → openai-compat when ENABLED=true", async () => {
    process.env.OPENAI_COMPAT_ENABLED = "true";
    const { resolveModel } = await import("../../src/lib/model-map");
    expect(resolveModel("gpt-5.5").provider).toBe("openai-compat");
  });

  test("detect: gpt-4o stays on copilot when ENABLED=true", async () => {
    process.env.OPENAI_COMPAT_ENABLED = "true";
    const { resolveModel } = await import("../../src/lib/model-map");
    expect(resolveModel("gpt-4o").provider).toBe("copilot");
  });

  test("apply: idempotent on/off + WeakMap snapshot restore", async () => {
    const { applyOpenAICompatOverrides } = await import(
      "../../src/lib/model-map/openai-compat-overrides"
    );
    const envOn = { OPENAI_COMPAT_ENABLED: "true" } as NodeJS.ProcessEnv;
    const envOff = { OPENAI_COMPAT_ENABLED: "false" } as NodeJS.ProcessEnv;
    const localMap: Record<string, ModelRoute> = {
      teamlead: {
        primary: "MiniMax-M2.7",
        primaryProvider: "minimax",
        fallback: "minimaxai/minimax-m2.7",
        fallbackProvider: "nvidia",
      },
      coder: { primary: "MiniMax-M2.7", primaryProvider: "minimax" },
    };
    const original = JSON.parse(JSON.stringify(localMap));

    applyOpenAICompatOverrides(localMap, envOn);
    expect(localMap.teamlead!.primary).toBe("gpt-5.5");
    expect(localMap.teamlead!.primaryProvider).toBe("openai-compat");
    expect(localMap.teamlead!.fallback).toBe("MiniMax-M2.7");
    expect(localMap.teamlead!.fallbackProvider).toBe("minimax");

    // idempotent: second apply enabled=true is no-op
    applyOpenAICompatOverrides(localMap, envOn);
    expect(localMap.teamlead!.primary).toBe("gpt-5.5");

    // off → restore from snapshot
    applyOpenAICompatOverrides(localMap, envOff);
    expect(localMap.teamlead).toEqual(original.teamlead);
    expect(localMap.coder).toEqual(original.coder);

    // throws on missing primaryProvider
    const broken: Record<string, ModelRoute> = {
      teamlead: { primary: "x" },
    };
    expect(() => applyOpenAICompatOverrides(broken, envOn)).toThrow(
      /no primaryProvider/,
    );
  });

  test("real MODEL_MAP not polluted across tests (default OFF)", async () => {
    delete process.env.OPENAI_COMPAT_ENABLED;
    const { MODEL_MAP, applyOpenAICompatOverrides } = await import(
      "../../src/lib/model-map"
    );
    applyOpenAICompatOverrides();
    expect(MODEL_MAP.teamlead!.primaryProvider).toBe("minimax");
    expect(MODEL_MAP.coder!.primaryProvider).toBe("minimax");
  });
});

describe("bootstrap integration (real createProviders)", () => {
  const savedEnv = { ...process.env };
  afterEach(async () => {
    // Restore env + reset MODEL_MAP overrides
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
    delete process.env.OPENAI_COMPAT_ENABLED;
    const { applyOpenAICompatOverrides } = await import(
      "../../src/lib/model-map"
    );
    applyOpenAICompatOverrides();
  });

  test("ENABLED=true → providers['openai-compat'] is OpenAICompatProvider instance", async () => {
    process.env.OPENAI_COMPAT_ENABLED = "true";
    process.env.OPENAI_COMPAT_BASE_URL = baseUrl;
    process.env.OPENAI_COMPAT_API_KEY = "k";
    process.env.NVIDIA_BASE_URL =
      process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
    process.env.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "nvapi-test";
    const { applyOpenAICompatOverrides } = await import(
      "../../src/lib/model-map"
    );
    applyOpenAICompatOverrides();
    const { createProviders } = await import("../../src/providers");
    const providers = await createProviders();
    expect(providers["openai-compat"]).toBeInstanceOf(OpenAICompatProvider);
  });
});
